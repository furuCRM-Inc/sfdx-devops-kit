/**
 * run.mjs — execute a plan and apply its quality gates.
 *
 * Gates are evaluated from parsed tool output, not from exit codes alone: a
 * deployment can exit non-zero for a flag mistake, and a coverage figure below
 * the threshold must fail even when the deploy itself "succeeded". Coverage is
 * carried from the validation deploy into the `unit_test` gate so Apex tests run
 * once, not twice.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  checkCoverage,
  parseAnalyzerResult,
  parseDeployResult,
} from "./results.mjs";
import { detectRtkSf, gateRtkSf } from "./rtk.mjs";

/**
 * Run a plan.
 *
 * @param {object} plan from planPipeline()
 * @param {object} config validated config
 * @param {{cwd?: string, dryRun?: boolean, onEvent?: Function}} options
 * @returns {{ok: boolean, results: object[], coverage: number|null}}
 */
export function runPipeline(
  plan,
  config,
  { cwd = process.cwd(), dryRun = false, onEvent } = {},
) {
  const emit = onEvent ?? (() => {});
  const results = [];
  const state = { coverage: null };
  let ok = true;

  const rtkConfig = config.ai_assist?.rtk_sf ?? {};
  let rtkDetection = null;

  for (const stage of plan.stages) {
    if (!stage.enabled) {
      results.push({
        id: stage.id,
        status: "skipped",
        message: stage.skipped_because,
      });
      emit({ type: "skip", stage, message: stage.skipped_because });
      continue;
    }

    if (stage.requires_rtk_sf) {
      rtkDetection ??= detectRtkSf({ python: rtkConfig.python, cwd });
      const gate = gateRtkSf(rtkConfig, rtkDetection);
      if (gate.action !== "run") {
        const status = gate.action === "fail" ? "failed" : "skipped";
        results.push({ id: stage.id, status, message: gate.message });
        emit({ type: gate.action, stage, message: gate.message });
        if (status === "failed") ok = false;
        continue;
      }
    }

    const outcome = runStage(stage, { cwd, dryRun, state, config, emit });
    results.push(outcome);
    if (outcome.status === "failed") {
      ok = false;
      if (stage.fail_on_error) {
        emit({
          type: "abort",
          stage,
          message: "stage failed; stopping pipeline",
        });
        break;
      }
    }
  }

  return { ok, results, coverage: state.coverage };
}

/** Run one stage, returning `{id, status, message, …}`. */
export function runStage(
  stage,
  { cwd, dryRun, state, config, emit = () => {} },
) {
  emit({ type: "start", stage });

  // The coverage gate reads the deploy result rather than running commands.
  if (stage.id === "unit_test") {
    if (dryRun) {
      return {
        id: stage.id,
        status: "dry-run",
        message: `would gate coverage at ${stage.coverage_threshold}%`,
      };
    }
    const gate = checkCoverage(state.coverage, stage.coverage_threshold);
    const outcome = {
      id: stage.id,
      status: gate.ok ? "passed" : "failed",
      message: gate.message,
    };
    emit({ type: gate.ok ? "pass" : "fail", stage, message: gate.message });
    return outcome;
  }

  const commandResults = [];
  for (const command of stage.commands) {
    if (dryRun) {
      commandResults.push({ command, status: 0, stdout: "", stderr: "" });
      continue;
    }
    const executed = execute(command, cwd);
    commandResults.push({ command, ...executed });
    if (executed.status !== 0) break;
  }

  if (dryRun) {
    return {
      id: stage.id,
      status: "dry-run",
      message: stage.commands.length
        ? stage.commands.join(" && ")
        : "(no command)",
    };
  }

  const failed = commandResults.find((entry) => entry.status !== 0);

  // Exit 127 is "command not found", which on a fresh checkout almost always
  // means dependencies are missing. Saying "exit 127" sends the reader hunting
  // through logs for a cause the shell already told us.
  if (failed && failed.status === 127) {
    const message =
      `command not found: ${failed.command.split(" ")[0]} — ` +
      `install dependencies first (npm install) or set a different command in ` +
      `pipeline_settings.${stage.id}.command`;
    emit({ type: "fail", stage, message });
    return { id: stage.id, status: "failed", message };
  }

  // ESLint exits 2 when its glob matches no files, which is the normal state of
  // a project that has no LWC yet. Failing the build for that would mean every
  // new project starts red.
  if (failed && (stage.id === "lint" || stage.id === "prettier")) {
    const output = `${failed.stdout}${failed.stderr}`;
    if (/No files matching the pattern|No files found/i.test(output)) {
      const message =
        "no files to check yet (the glob matched nothing) — treated as a pass";
      emit({ type: "pass", stage, message });
      return { id: stage.id, status: "passed", message };
    }
  }

  const detail = interpret(stage, commandResults, { cwd, state, config });
  const status =
    detail.ok === false || (detail.ok === undefined && failed)
      ? "failed"
      : "passed";
  const message = detail.message ?? (failed ? `exit ${failed.status}` : "ok");

  emit({ type: status === "passed" ? "pass" : "fail", stage, message });
  return { id: stage.id, status, message, ...detail.extra };
}

/** Stage-specific interpretation of tool output. */
function interpret(stage, commandResults, { cwd, state, config }) {
  const last = commandResults[commandResults.length - 1];

  if (stage.id === "code_analyzer") {
    const payload = readJsonFile(
      path.join(cwd, stage.output_file ?? "code-analyzer-results.json"),
    );
    if (!payload) {
      // No report file: fall back to the process exit code, which the analyzer
      // sets from --severity-threshold on its own.
      return {
        ok: last?.status === 0,
        message:
          last?.status === 0
            ? `no violations at severity <= ${stage.severity_threshold}`
            : `analyzer exited ${last?.status} (report file not found)`,
      };
    }
    const summary = parseAnalyzerResult(payload, stage.severity_threshold);
    return {
      ok: summary.ok,
      message: summary.message,
      extra: { violations: summary.violations, counts: summary.counts },
    };
  }

  if (stage.id === "validate_deploy" || stage.id === "deploy") {
    const payload = parseJson(last?.stdout);
    if (!payload) {
      return {
        ok: false,
        message: `Salesforce CLI returned non-JSON output: ${truncate(last?.stderr || last?.stdout)}`,
      };
    }
    const summary = parseDeployResult(payload);
    if (summary.coverage !== null) state.coverage = summary.coverage;
    return {
      ok: summary.ok,
      message:
        summary.coverage === null
          ? summary.message
          : `${summary.message}; coverage ${summary.coverage}%`,
      extra: {
        components: summary.componentsDeployed,
        component_errors: summary.componentErrors,
        failures: summary.failures,
        test_failures: summary.testFailures,
        coverage: summary.coverage,
      },
    };
  }

  // Stages without a structured report (lint, prettier, integration, e2e,
  // documentation) are judged by their exit code — but "exit 1" tells the reader
  // nothing they can act on. The tool already printed the reason, so carry its
  // own summary line, and keep the tail for the caller to display.
  if (!last || last.status === 0) {
    return {
      ok: last ? last.status === 0 : true,
      message: last?.status === 0 ? "ok" : undefined,
    };
  }
  const failure = toolFailure(last);
  return {
    ok: false,
    message: failure.summary
      ? `${failure.summary} (exit ${last.status})`
      : undefined,
    extra: { output: failure.output },
  };
}

/**
 * A one-line reason and the tail of a tool's output.
 *
 * ESLint and Prettier both end with a summary line ("✖ 2 problems", "Code style
 * issues found ..."); when neither is present the last non-empty line is still
 * closer to the cause than the exit code is.
 */
function toolFailure(entry, { maxLines = 40, maxChars = 4000 } = {}) {
  const combined = `${entry.stdout ?? ""}${entry.stderr ?? ""}`.replace(
    /\s+$/,
    "",
  );
  const lines = combined.split("\n").filter((line) => line.trim() !== "");
  const summary =
    lines.find((line) => /✖\s+\d+\s+problems?/.test(line))?.trim() ??
    lines.find((line) => /Code style issues found/i.test(line))?.trim() ??
    lines[lines.length - 1]?.trim();
  const tail = lines.slice(-maxLines).join("\n");
  return {
    // The caller prints its own ✖, so a leading one from the tool would double up.
    summary: summary ? truncate(summary.replace(/^[✖✗×x]\s*/i, ""), 200) : null,
    output: tail.length > maxChars ? `…\n${tail.slice(-maxChars)}` : tail,
  };
}

function execute(command, cwd) {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  return {
    status: result.status ?? (result.error ? 127 : 1),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function parseJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  // The CLI sometimes prints warnings before the JSON body.
  const start = trimmed.indexOf("{");
  if (start === -1) return null;
  try {
    return JSON.parse(trimmed.slice(start));
  } catch {
    return null;
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function truncate(text, limit = 200) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}
