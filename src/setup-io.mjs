/**
 * setup-io.mjs — terminal and process I/O for the setup wizard.
 *
 * Kept apart from setup.mjs so the decisions stay testable without a terminal.
 * The one rule enforced here: a secret is never echoed, never placed in argv,
 * and never written inside the project. Values go to child processes on stdin.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Writable } from "node:stream";

export function createIO({
  input = process.stdin,
  output = process.stdout,
  terminal,
} = {}) {
  /**
   * Everything readline prints — prompts and the echo of what is typed — goes
   * through this gate. Closing it is how a secret is read without appearing on
   * screen or in the terminal's scrollback.
   */
  const gate = new Writable({
    write(chunk, encoding, callback) {
      if (!gate.muted) output.write(chunk);
      callback();
    },
  });
  gate.muted = false;

  // readline must own the echo (`terminal: true` puts the tty in raw mode and
  // stops the driver echoing), otherwise muting this gate would hide nothing.
  const rl = readline.createInterface({
    input,
    output: gate,
    terminal: terminal ?? Boolean(input.isTTY),
  });
  rl.on("SIGINT", () => {
    gate.muted = false;
    rl.close();
    output.write("\n中断しました。\n");
    process.exit(130);
  });

  const ask = (question, fallback = "") =>
    new Promise((resolve) => {
      const suffix = fallback ? ` [${fallback}]` : "";
      rl.question(`${question}${suffix}: `, (answer) =>
        resolve(answer.trim() || fallback),
      );
    });

  /**
   * Yes/no, re-asked until it is actually yes or no.
   *
   * Treating an unrecognised answer as "no" silently discards the operator's
   * intent — during a setup run that means skipping an org login they asked for.
   */
  const confirm = async (question, fallback = true) => {
    for (;;) {
      const answer = await ask(`${question} (y/n)`, fallback ? "y" : "n");
      if (/^(y|yes|はい)$/i.test(answer)) return true;
      if (/^(n|no|いいえ)$/i.test(answer)) return false;
      output.write(`  y か n で答えてください（入力: ${answer}）\n`);
    }
  };

  /**
   * Read a value without echoing it.
   *
   * The prompt is written straight to the real output, then the gate is closed
   * for the duration of the answer. readline still does the reading, so a key
   * that arrives as one pasted chunk, a backspace and Ctrl-C all behave.
   */
  const askSecret = (question) =>
    new Promise((resolve) => {
      output.write(`${question}: `);
      gate.muted = true;
      rl.question("", (answer) => {
        gate.muted = false;
        output.write("\n");
        resolve(answer.trim());
      });
    });

  return { ask, confirm, askSecret, close: () => rl.close() };
}

/** Run a command, returning `{ok, stdout, stderr}`; never throws. */
export function run(command, args, { cwd = process.cwd(), input } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    input,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Run a command attached to the terminal (for browser logins and the like). */
export function runInteractive(command, args, { cwd = process.cwd() } = {}) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  return {
    ok: !result.error && result.status === 0,
    status: result.status ?? 1,
  };
}

export function commandExists(command) {
  return run(process.platform === "win32" ? "where" : "which", [command]).ok;
}

/** Orgs the Salesforce CLI already knows about. */
export function listOrgs() {
  const result = run("sf", ["org", "list", "--json"]);
  if (!result.ok) return [];
  try {
    const payload = JSON.parse(result.stdout).result ?? {};
    const rows = [
      ...(payload.nonScratchOrgs ?? []),
      ...(payload.scratchOrgs ?? []),
      ...(payload.other ?? []),
    ];
    const seen = new Set();
    return rows.filter((org) => {
      const id = org.alias || org.username;
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  } catch {
    return [];
  }
}

/**
 * The SFDX auth URL for an org — a credential.
 *
 * Returned to the caller only to be piped into `gh secret set` on stdin; it is
 * never logged, and never passed as a command-line argument.
 */
export function readAuthUrl(alias) {
  const result = run("sf", [
    "org",
    "display",
    "--target-org",
    alias,
    "--verbose",
    "--json",
  ]);
  if (!result.ok) return null;
  try {
    return JSON.parse(result.stdout).result?.sfdxAuthUrl ?? null;
  } catch {
    return null;
  }
}

/**
 * `owner/repo` for the origin remote, or null when it is not a GitHub remote.
 *
 * Passed to gh explicitly: a checkout with more than one remote (a fork and its
 * upstream, say) makes gh refuse with "multiple remotes detected".
 */
export function githubRepoSlug({ cwd = process.cwd() } = {}) {
  const remote = run("git", ["remote", "get-url", "origin"], { cwd });
  if (!remote.ok) return null;
  const match = /github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\s*$/.exec(
    remote.stdout,
  );
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * Secret names already on the repository.
 *
 * Reports *why* it cannot read them, because the three causes need different
 * fixes: install gh, authenticate, or run inside the repository. A single
 * "gh is unusable" message sends people to reinstall a working tool.
 *
 * @returns {{ok: boolean, reason: "ok"|"missing"|"unauthenticated"|"no-repo"|"error",
 *            detail: string, secrets: Set<string>}}
 */
export function listGitHubSecrets({ cwd = process.cwd() } = {}) {
  const empty = new Set();
  if (!commandExists("gh")) {
    return {
      ok: false,
      reason: "missing",
      detail: "gh CLI が見つかりません",
      secrets: empty,
    };
  }
  if (!run("git", ["rev-parse", "--is-inside-work-tree"], { cwd }).ok) {
    return {
      ok: false,
      reason: "no-repo",
      detail: "git リポジトリではありません",
      secrets: empty,
    };
  }
  const slug = githubRepoSlug({ cwd });
  if (!slug) {
    return {
      ok: false,
      reason: "no-repo",
      detail: "GitHub の origin リモートが設定されていません",
      secrets: empty,
    };
  }
  if (!run("gh", ["auth", "status"]).ok) {
    return {
      ok: false,
      reason: "unauthenticated",
      detail: "gh が未認証です",
      secrets: empty,
    };
  }

  const result = run(
    "gh",
    ["secret", "list", "--repo", slug, "--json", "name"],
    { cwd },
  );
  if (!result.ok) {
    return {
      ok: false,
      reason: "error",
      detail:
        result.stderr.trim().split("\n")[0] || "gh secret list に失敗しました",
      secrets: empty,
    };
  }
  try {
    return {
      ok: true,
      reason: "ok",
      detail: slug,
      secrets: new Set(JSON.parse(result.stdout).map((row) => row.name)),
    };
  } catch {
    // Older gh versions print a plain table.
    const names = result.stdout
      .split("\n")
      .map((line) => line.split(/\s+/)[0])
      .filter(Boolean);
    return { ok: true, reason: "ok", detail: slug, secrets: new Set(names) };
  }
}

/** Store a secret, passing the value through stdin so it stays out of argv. */
export function setGitHubSecret(
  name,
  value,
  { cwd = process.cwd(), slug } = {},
) {
  const repo = slug ?? githubRepoSlug({ cwd });
  const args = repo
    ? ["secret", "set", name, "--repo", repo]
    : ["secret", "set", name];
  return run("gh", args, { cwd, input: value });
}

/** Write a file with owner-only permissions, creating parent directories. */
export function writeSecretFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, contents, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

/** Check a Backlog credential pair without storing or printing it. */
export async function verifyBacklog(domain, apiKey) {
  try {
    const response = await fetch(
      `https://${domain}/api/v2/users/myself?apiKey=${encodeURIComponent(apiKey)}`,
      { signal: AbortSignal.timeout(15000) },
    );
    if (!response.ok) {
      return { ok: false, detail: `HTTP ${response.status}` };
    }
    const body = await response.json();
    return { ok: true, detail: `${body.name} (userId ${body.id})` };
  } catch (error) {
    return { ok: false, detail: String(error.message || error) };
  }
}
