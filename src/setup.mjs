/**
 * setup.mjs — the interactive project setup wizard's logic.
 *
 * Everything that decides *what* to do lives here as pure functions; the CLI
 * supplies the I/O (prompting, running commands, reading the keyboard). That
 * split keeps the parts that must be right — rewriting the config, deriving
 * secret names, choosing what to authorize — testable without a terminal.
 *
 * Two rules the wizard never breaks:
 *   - A secret never appears in argv, in a log line, or in the repository. Auth
 *     URLs and API keys are passed to child processes through stdin and stored
 *     outside the project.
 *   - The config file is edited surgically. It is meant to be read and changed
 *     by humans, so its comments and ordering survive.
 */

import { authSecretName } from "./config.mjs";

/** Where the Backlog credentials live — outside any repository. */
export const BACKLOG_ENV_PATH = ".config/sfdx-devops-kit/backlog.env";

export const ENV_KEY_PATTERN = /^[a-z][a-z0-9_-]*$/i;

/**
 * Environment keys a team usually wants, in pipeline order.
 * Offered as defaults; the wizard accepts anything matching ENV_KEY_PATTERN.
 */
export const SUGGESTED_KEYS = ["dev", "st", "uat", "prod"];

/**
 * Guess an environment key and type from an org alias or username.
 *
 * `sf org list` knows the orgs a developer already authorized, so the wizard
 * offers those rather than asking them to retype aliases they already have.
 */
export function suggestEnvironment(org) {
  const label = String(org.alias || org.username || "").toLowerCase();
  const isScratch = Boolean(org.isScratch || org.expirationDate);

  let key = label.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "org";
  let type = isScratch ? "scratch" : "sandbox";

  if (/prod|production/.test(label) && !/sandbox|sbx/.test(label)) {
    key = "prod";
    type = "production";
  } else if (/uat/.test(label)) key = "uat";
  else if (/\bst\b|staging|stg/.test(label)) key = "st";
  else if (/sit/.test(label)) key = "sit";
  else if (/dev/.test(label)) key = "dev";

  return { key, type, alias: org.alias || org.username };
}

/**
 * Render the `environments:` block for the config file.
 *
 * @param {{key: string, alias: string, type: string, is_test_target?: boolean,
 *          deploy_manifest?: string, source_dir?: string, metadata?: string}[]} environments
 */
export function renderEnvironmentsBlock(environments) {
  const lines = ["environments:"];
  for (const env of environments) {
    const key = ENV_KEY_PATTERN.test(env.key) && !env.key.includes("-")
      ? env.key
      : JSON.stringify(env.key);
    lines.push(`  ${key}:`);
    lines.push(`    alias: ${JSON.stringify(env.alias)}`);
    lines.push(`    type: ${JSON.stringify(env.type)}`);
    if (env.is_test_target) {
      lines.push("    is_test_target: true # CI の検証と E2E の実行先");
    }
    // At most one deployment selector: the Salesforce CLI rejects combinations.
    for (const selector of ["deploy_manifest", "source_dir", "metadata"]) {
      if (env[selector]) {
        lines.push(`    ${selector}: ${JSON.stringify(env[selector])}`);
        break;
      }
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Replace the `environments:` block in a config file, leaving everything else
 * — comments, key order, unrelated sections — exactly as it was.
 *
 * @returns {string} the updated file contents
 */
export function upsertEnvironments(configText, environments) {
  const block = renderEnvironmentsBlock(environments);
  const lines = configText.split("\n");
  const start = lines.findIndex((line) => /^environments:\s*(#.*)?$/.test(line));

  if (start === -1) {
    // No block yet: insert before pipeline_settings, or append.
    const anchor = lines.findIndex((line) => /^pipeline_settings:/.test(line));
    const insertAt = anchor === -1 ? lines.length : anchor;
    const before = lines.slice(0, insertAt).join("\n").trimEnd();
    const after = lines.slice(insertAt).join("\n");
    return `${before}\n\n${block}\n${after}`;
  }

  // The block runs until the next top-level key (a line starting in column 0
  // that is not a comment or blank).
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || /^\s/.test(line)) continue;
    if (line.startsWith("#")) continue;
    end = index;
    break;
  }

  // Keep any comment lines that immediately precede the next section.
  let tailStart = end;
  while (tailStart > start + 1 && lines[tailStart - 1].startsWith("#")) tailStart -= 1;
  const keptComments = lines.slice(tailStart, end);

  return [
    ...lines.slice(0, start),
    ...block.trimEnd().split("\n"),
    "",
    ...keptComments,
    ...lines.slice(end),
  ].join("\n");
}

/** Replace a simple `key: value` scalar at the top level of a mapping. */
export function setScalar(configText, path, value) {
  const [section, key] = path.split(".");
  const lines = configText.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^${section}:\\s*(#.*)?$`).test(line));
  if (start === -1) return configText;

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() !== "" && !/^\s/.test(line) && !line.startsWith("#")) break;
    const match = line.match(new RegExp(`^(\\s+)${key}:\\s*(.*?)(\\s+#.*)?$`));
    if (match) {
      lines[index] = `${match[1]}${key}: ${JSON.stringify(value)}${match[3] ?? ""}`;
      return lines.join("\n");
    }
  }
  return configText;
}

/** Same, for a top-level scalar such as `project_name`. */
export function setTopLevelScalar(configText, key, value) {
  const lines = configText.split("\n");
  const index = lines.findIndex((line) => new RegExp(`^${key}:`).test(line));
  if (index === -1) return configText;
  const comment = lines[index].match(/(\s+#.*)$/)?.[1] ?? "";
  lines[index] = `${key}: ${JSON.stringify(value)}${comment}`;
  return lines.join("\n");
}

/**
 * Which environments still need authorizing, and which secrets are missing.
 *
 * @param {object[]} environments from the config
 * @param {Set<string>} authorizedAliases from `sf org list`
 * @param {Set<string>} existingSecrets from `gh secret list`
 */
export function planCredentials(environments, authorizedAliases, existingSecrets) {
  return environments.map((env) => {
    const secret = authSecretName(env);
    return {
      key: env.key,
      alias: env.alias,
      type: env.type,
      secret,
      authorized: authorizedAliases.has(env.alias),
      secretPresent: existingSecrets.has(secret),
    };
  });
}

/** Contents of the Backlog credentials file (mode 0600, outside the repo). */
export function backlogEnvContents(domain, apiKey) {
  return (
    "# sfdx-devops-kit — Backlog credentials.\n" +
    "# Not in the repository on purpose: .mcp.json passes these through from the\n" +
    "# environment. Keep this file at mode 600 and out of version control.\n" +
    `export BACKLOG_DOMAIN=${domain}\n` +
    `export BACKLOG_API_KEY=${apiKey}\n`
  );
}

/** Normalize whatever the user pasted as a Backlog domain. */
export function normalizeBacklogDomain(input) {
  return String(input || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

/**
 * A Backlog API key is 64 alphanumeric characters. Pasting the surrounding
 * prose along with it is a common mistake, so the value is validated rather
 * than stored and left to fail later with an opaque 401.
 */
export function validateBacklogKey(input) {
  const value = String(input || "").trim();
  if (!value) return { ok: false, reason: "キーが空です。" };
  if (!/^[A-Za-z0-9]+$/.test(value)) {
    return { ok: false, reason: "英数字以外が含まれています（説明文まで貼り付けていませんか）。" };
  }
  if (value.length < 32) {
    return { ok: false, reason: `短すぎます（${value.length} 文字）。Backlog のキーは 64 文字です。` };
  }
  return { ok: true, value };
}

/** The closing summary: what was done, and what is left for the operator. */
export function nextSteps({ secretsSet, unauthorized, backlogConfigured, rtkInstalled }) {
  const steps = [];
  if (unauthorized.length > 0) {
    steps.push(
      `未認証の org: ${unauthorized.join(", ")} — \`sf org login web --alias <別名>\` で認証してください。`,
    );
  }
  if (!secretsSet) {
    steps.push(
      "GitHub Secrets が未設定です。`npx sfdx-devops-kit validate` が必要な名前を表示します。",
    );
  }
  if (!backlogConfigured) {
    steps.push("Backlog 連携を使う場合は、再実行して資格情報を設定してください。");
  }
  if (!rtkInstalled) {
    steps.push(
      'rtk-sf 未導入: pip install "git+https://github.com/furuCRM-Inc/rtk-sf.git@v0.10.1"',
    );
  }
  steps.push("`npx sfdx-devops-kit plan` で CI が実行する内容を確認できます。");
  return steps;
}
