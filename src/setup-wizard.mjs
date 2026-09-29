/**
 * setup-wizard.mjs — the `sfdx-devops-kit setup` flow.
 *
 * Walks a project from "files are installed" to "the pipeline can actually
 * run": environments declared, orgs authorized, GitHub Secrets stored, Backlog
 * credentials in place, rtk-sf indexed. Everything it decides comes from
 * setup.mjs; everything it touches goes through setup-io.mjs.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CONFIG_FILENAME, loadConfig, resolveEnvironment, validateConfig } from "./config.mjs";
import { detectRtkSf, RTK_INSTALL_HINT, RTK_MCP_HINT } from "./rtk.mjs";
import {
  BACKLOG_ENV_PATH,
  backlogEnvContents,
  ENV_KEY_PATTERN,
  normalizeBacklogDomain,
  planCredentials,
  setScalar,
  setTopLevelScalar,
  suggestEnvironment,
  upsertEnvironments,
  validateBacklogKey,
} from "./setup.mjs";
import {
  commandExists,
  createIO,
  listGitHubSecrets,
  listOrgs,
  readAuthUrl,
  runInteractive,
  setGitHubSecret,
  verifyBacklog,
  writeSecretFile,
} from "./setup-io.mjs";

const TICK = "✔";
const CROSS = "✖";
const WARN = "⚠";

export async function runSetup({ cwd = process.cwd(), io: injectedIO, skip = {} } = {}) {
  const io = injectedIO ?? createIO();
  const log = (line = "") => console.log(line);
  const section = (title) => {
    log("");
    log(`── ${title} ${"─".repeat(Math.max(0, 56 - title.length))}`);
  };

  try {
    log("sfdx-devops-kit セットアップ");
    log(`プロジェクト: ${cwd}`);

    const configPath = path.join(cwd, CONFIG_FILENAME);
    if (!fs.existsSync(configPath)) {
      log(`${CROSS} ${CONFIG_FILENAME} がありません。先に \`sfdx-devops-kit init .\` を実行してください。`);
      return 2;
    }

    // -- 1. Project identity ------------------------------------------------
    section("1. プロジェクト");
    let text = fs.readFileSync(configPath, "utf8");
    const current = validateConfig(await parseYaml(text)).config;
    const projectName = await io.ask("プロジェクト名", current.project_name || path.basename(cwd));
    text = setTopLevelScalar(text, "project_name", projectName);

    // -- 2. Environments ----------------------------------------------------
    section("2. 環境（org）");
    const environments = skip.environments
      ? Object.entries(current.environments).map(([key, env]) => ({ key, ...env }))
      : await collectEnvironments(io, current, log);

    if (environments.length === 0) {
      log(`${CROSS} 環境が 1 つも設定されていません。`);
      return 2;
    }
    const rewritten = upsertEnvironments(text, environments);
    if (rewritten === text) {
      log(`${TICK} 環境設定は変更なし（${environments.length} 環境）`);
    } else {
      text = rewritten;
      fs.writeFileSync(configPath, text, "utf8");
      log(`${TICK} ${CONFIG_FILENAME} に ${environments.length} 環境を書き込みました`);
    }

    // -- 3. Authentication --------------------------------------------------
    section("3. org 認証");
    const authorized = new Set(listOrgs().map((org) => org.alias || org.username));
    const unauthorized = [];
    for (const env of environments) {
      if (authorized.has(env.alias)) {
        log(`${TICK} ${env.key.padEnd(12)} ${env.alias} — 認証済み`);
        continue;
      }
      log(`${WARN} ${env.key.padEnd(12)} ${env.alias} — 未認証`);
      if (env.type === "scratch") {
        log("   （scratch org は作成時に認証されます）");
        unauthorized.push(env.alias);
        continue;
      }
      const doLogin = await io.confirm(`   ブラウザで ${env.alias} にログインしますか`, false);
      if (!doLogin) {
        unauthorized.push(env.alias);
        continue;
      }
      const result = runInteractive("sf", [
        "org", "login", "web", "--alias", env.alias,
        ...(env.type === "sandbox" ? ["--instance-url", "https://test.salesforce.com"] : []),
      ]);
      if (result.ok) {
        log(`${TICK} ${env.alias} を認証しました`);
        authorized.add(env.alias);
      } else {
        log(`${CROSS} ${env.alias} の認証に失敗しました`);
        unauthorized.push(env.alias);
      }
    }

    // -- 4. GitHub Secrets --------------------------------------------------
    section("4. GitHub Secrets（CI 用の org 認証）");
    let secretsSet = false;
    const secretsList = listGitHubSecrets({ cwd });
    if (!secretsList.ok) {
      const remedy = {
        missing: "gh CLI を導入してください: https://cli.github.com/",
        "no-repo": "git リポジトリを作成し、GitHub の origin リモートを設定してください。",
        unauthenticated: "`gh auth login` で認証してください。",
        error: "gh のエラーを解消してから再実行してください。",
      }[secretsList.reason];
      log(`${WARN} Secrets の自動登録をスキップします — ${secretsList.detail}`);
      log(`   ${remedy}`);
      log("   登録すべき名前は `npx sfdx-devops-kit validate` が表示します。");
    } else {
      log(`対象リポジトリ: ${secretsList.detail}`);
      const plans = planCredentials(environments, authorized, secretsList.secrets);
      for (const plan of plans) {
        if (plan.secretPresent) {
          log(`${TICK} ${plan.secret} — 登録済み`);
          secretsSet = true;
          continue;
        }
        if (!plan.authorized) {
          log(`${WARN} ${plan.secret} — ${plan.alias} が未認証のため取得できません`);
          continue;
        }
        const store = await io.confirm(`   ${plan.secret} を登録しますか（${plan.alias}）`, true);
        if (!store) continue;

        // The auth URL is a credential: read it, pipe it to gh on stdin, and
        // never let it reach a log line or an argument vector.
        const authUrl = readAuthUrl(plan.alias);
        if (!authUrl) {
          log(`${CROSS} ${plan.alias} の認証 URL を取得できませんでした`);
          continue;
        }
        const result = setGitHubSecret(plan.secret, authUrl, { cwd, slug: secretsList.detail });
        log(result.ok ? `${TICK} ${plan.secret} を登録しました` : `${CROSS} ${plan.secret} の登録に失敗: ${result.stderr.trim().split("\n")[0]}`);
        secretsSet = secretsSet || result.ok;
      }
    }

    // -- 5. Backlog ---------------------------------------------------------
    section("5. Backlog 連携（任意）");
    let backlogConfigured = false;
    const wantBacklog = skip.backlog ? false : await io.confirm("Backlog 連携を設定しますか", true);
    if (wantBacklog) {
      const projectKey = await io.ask(
        "Backlog プロジェクトキー（例: PROJ）",
        current.backlog_integration?.project_key || "",
      );
      if (projectKey) text = setScalar(text, "backlog_integration.project_key", projectKey);

      const domain = normalizeBacklogDomain(
        await io.ask("Backlog ドメイン（例: your-space.backlog.com）"),
      );
      if (domain) {
        let stored = false;
        for (let attempt = 0; attempt < 3 && !stored; attempt += 1) {
          const raw = await io.askSecret("API キー（入力は表示されません。個人設定 → API で発行）");
          const validation = validateBacklogKey(raw);
          if (!validation.ok) {
            log(`${CROSS} ${validation.reason}`);
            continue;
          }
          const check = await verifyBacklog(domain, validation.value);
          if (!check.ok) {
            log(`${CROSS} 認証に失敗しました（${check.detail}）`);
            continue;
          }
          const target = path.join(os.homedir(), BACKLOG_ENV_PATH);
          writeSecretFile(target, backlogEnvContents(domain, validation.value));
          log(`${TICK} 認証成功: ${check.detail}`);
          log(`${TICK} 資格情報を ${target} に保存しました（mode 600、リポジトリ外）`);
          log("   シェルで読み込むには次を ~/.zshrc などに追加してください:");
          log(`     set -a; . ~/${BACKLOG_ENV_PATH}; set +a`);
          stored = true;
          backlogConfigured = true;
        }
      }
      fs.writeFileSync(configPath, text, "utf8");
    }

    // -- 6. rtk-sf ----------------------------------------------------------
    section("6. rtk-sf（既定の AI コンパニオン）");
    const detection = detectRtkSf({ python: current.ai_assist?.rtk_sf?.python, cwd });
    if (detection.installed) {
      log(`${TICK} ${detection.detail}`);
      if (await io.confirm("   メタデータを索引しますか（rtk_sf index）", true)) {
        const result = runInteractive(detection.python, ["-m", "rtk_sf", "index"], { cwd });
        log(result.ok ? `${TICK} 索引を作成しました` : `${WARN} 索引に失敗しました`);
      }
      if (commandExists("claude") && await io.confirm("   MCP サーバーを登録しますか", true)) {
        const result = runInteractive(
          "claude",
          ["mcp", "add", "rtk-sf", "--", detection.python, "-m", "rtk_sf", "serve"],
          { cwd },
        );
        log(result.ok ? `${TICK} MCP サーバーを登録しました` : `${WARN} 登録できませんでした: ${RTK_MCP_HINT}`);
      }
    } else {
      log(`${WARN} rtk-sf 未導入（${detection.detail}）`);
      log(`   ${RTK_INSTALL_HINT}`);
      log("   未導入でもパイプラインは動作します（該当ステージのみスキップ）。");
    }

    // -- 7. Verify ----------------------------------------------------------
    section("7. 検証");
    const { errors, warnings } = loadConfig({ cwd });
    for (const warning of warnings) log(`${WARN} ${warning}`);
    for (const error of errors) log(`${CROSS} ${error}`);
    if (errors.length > 0) {
      log("");
      log(`${CROSS} 設定にエラーがあります。修正後 \`npx sfdx-devops-kit validate\` で再確認してください。`);
      return 1;
    }
    log(`${TICK} 設定は有効です`);

    log("");
    log("次のステップ:");
    for (const step of buildNextSteps({ secretsSet, unauthorized, backlogConfigured, detection })) {
      log(`  - ${step}`);
    }
    return 0;
  } finally {
    io.close?.();
  }
}

function buildNextSteps({ secretsSet, unauthorized, backlogConfigured, detection }) {
  const steps = [];
  if (unauthorized.length > 0) {
    steps.push(`未認証の org: ${unauthorized.join(", ")} — \`sf org login web --alias <別名>\``);
  }
  if (!secretsSet) {
    steps.push("GitHub Secrets が未登録です。`npx sfdx-devops-kit validate` が必要な名前を表示します。");
  }
  if (!backlogConfigured) steps.push("Backlog 連携は未設定です（後から再実行できます）。");
  if (!detection.installed) steps.push("rtk-sf を導入すると設計書生成と AI レビューが有効になります。");
  steps.push("`npx sfdx-devops-kit plan` で CI が実行する内容を確認");
  steps.push("`npx sfdx-devops-kit run --dry-run` で実行内容を試算");
  return steps;
}

/** Interactive environment collection, seeded from the orgs the CLI knows. */
async function collectEnvironments(io, current, log) {
  const known = listOrgs();
  const existing = Object.entries(current.environments ?? {}).map(([key, env]) => ({ key, ...env }));

  if (existing.length > 0) {
    log("現在の設定:");
    for (const env of existing) log(`  ${env.key.padEnd(12)} ${env.alias} (${env.type})`);
    if (!(await io.confirm("設定し直しますか", false))) return existing;
  }

  if (known.length > 0) {
    log("");
    log("認証済みの org:");
    known.forEach((org, index) => {
      const suggestion = suggestEnvironment(org);
      log(`  ${String(index + 1).padStart(2)}. ${(org.alias || org.username).padEnd(24)} → ${suggestion.key} (${suggestion.type})`);
    });
    log("   番号をカンマ区切りで選択（例: 1,3,4）。空欄なら手入力に進みます。");
    const selection = await io.ask("選択");
    if (selection) {
      const picked = selection
        .split(",")
        .map((part) => known[Number(part.trim()) - 1])
        .filter(Boolean)
        .map(suggestEnvironment);
      if (picked.length > 0) return finalize(io, picked, log);
    }
  }

  // Manual entry.
  const collected = [];
  log("");
  log("環境を 1 つずつ入力します（キーを空欄にすると終了）。");
  for (;;) {
    const key = await io.ask(`環境キー（例: ${["dev", "st", "uat", "prod"][collected.length] ?? "sit"}）`);
    if (!key) break;
    if (!ENV_KEY_PATTERN.test(key)) {
      log(`${CROSS} 英数字・アンダースコア・ハイフンのみ使用できます。`);
      continue;
    }
    const alias = await io.ask("  org 別名またはユーザー名");
    if (!alias) continue;
    const type = await io.ask("  種別 (sandbox/production/scratch/developer)", "sandbox");
    collected.push({ key, alias, type });
  }
  return finalize(io, collected, log);
}

/** Pick the test target and any deployment selectors. */
async function finalize(io, environments, log) {
  if (environments.length === 0) return environments;

  log("");
  const defaultTarget =
    environments.find((env) => env.key === "st") ??
    environments.find((env) => env.type !== "production") ??
    environments[0];
  const targetKey = await io.ask(
    `CI の検証・E2E を実行する環境（is_test_target）`,
    defaultTarget.key,
  );
  for (const env of environments) {
    env.is_test_target = env.key === targetKey && env.type !== "production";
  }
  if (!environments.some((env) => env.is_test_target)) {
    log(`${WARN} is_test_target を設定できませんでした（production は対象にできません）。`);
  }

  const production = environments.filter((env) => env.type === "production");
  for (const env of production) {
    const useManifest = await io.confirm(
      `${env.key}: リリース manifest（manifest/package.xml）でデプロイしますか`,
      true,
    );
    if (useManifest) env.deploy_manifest = "manifest/package.xml";
  }
  return environments;
}

async function parseYaml(text) {
  const { load } = await import("js-yaml");
  return load(text) ?? {};
}
