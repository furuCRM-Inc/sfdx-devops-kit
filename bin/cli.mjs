#!/usr/bin/env node
/**
 * sfdx-devops-kit — configuration-driven pipeline CLI.
 *
 * Every command reads `sfdx-pipeline.config.yml`, which is the single source of
 * truth shared by GitHub Actions, this CLI and the Claude Code skills.
 *
 * Exit codes: 0 success · 1 a gate failed · 2 configuration or usage error.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  backlogTools,
  loadConfig,
  resolveEnvironment,
  resolveStatus,
  STAGE_ORDER,
} from "../src/config.mjs";
import { planPipeline } from "../src/stages.mjs";
import { runPipeline } from "../src/run.mjs";
import { scaffold } from "../src/scaffold.mjs";
import {
  currentBranch,
  deriveDeliverables,
  readDiff,
  renderMarkdown,
  renderPackageXml,
  resolvePullRequest,
} from "../src/deliverables.mjs";
import { ticketContext } from "../src/backlog.mjs";
import { detectRtkSf, rtkAdvice, hasIndex } from "../src/rtk.mjs";

const EXIT_OK = 0;
const EXIT_GATE = 1;
const EXIT_USAGE = 2;

const pkg = JSON.parse(
  fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
);

main(process.argv.slice(2));

function main(argv) {
  const { command, positionals, flags } = parseArgs(argv);

  if (flags.version || command === "version") {
    console.log(pkg.version);
    process.exit(EXIT_OK);
  }
  if (!command || flags.help || command === "help") {
    console.log(usage());
    process.exit(command && command !== "help" ? EXIT_USAGE : EXIT_OK);
  }

  const handlers = {
    init: cmdInit,
    validate: cmdValidate,
    plan: cmdPlan,
    run: cmdRun,
    deliverables: cmdDeliverables,
    ticket: cmdTicket,
    backlog: cmdBacklog,
    doctor: cmdDoctor,
  };

  const handler = handlers[command];
  if (!handler) {
    console.error(`Unknown command "${command}".\n\n${usage()}`);
    process.exit(EXIT_USAGE);
  }

  try {
    process.exit(handler({ positionals, flags }));
  } catch (error) {
    console.error(`✖ ${error.message}`);
    process.exit(EXIT_USAGE);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdInit({ positionals, flags }) {
  const targetDir = path.resolve(positionals[0] ?? flags.target ?? process.cwd());
  const dryRun = Boolean(flags["dry-run"]);

  if (!fs.existsSync(path.join(targetDir, "sfdx-project.json")) && !flags.force) {
    console.error(
      `✖ ${targetDir} is not an SFDX project (no sfdx-project.json).\n` +
        "  Create one first:  sf project generate --name MyProject --template standard\n" +
        "  Or pass --force to scaffold anyway.",
    );
    return EXIT_USAGE;
  }

  const projectName = flags["project-name"] ?? path.basename(targetDir);
  const result = scaffold({ targetDir, force: Boolean(flags.force), dryRun, projectName });

  console.log(`${dryRun ? "[dry run] " : ""}sfdx-devops-kit init → ${targetDir}`);
  report("created", result.created);
  report("overwritten", result.overwritten);
  report("kept (already present, use --force to replace)", result.skipped);
  if (result.dirs.length) console.log(`  directories: ${result.dirs.join(", ")}`);
  console.log(`  package.json: ${result.packageJson}`);

  const detection = detectRtkSf({ cwd: targetDir });
  console.log(`\n${rtkAdvice(detection)}`);
  if (detection.installed && !hasIndex(targetDir)) {
    console.log("  (this project has no .rtk-sf index yet — run the index command above)");
  }

  console.log("\nNext steps:");
  console.log("  1. Edit sfdx-pipeline.config.yml (org aliases, thresholds, Backlog project key).");
  console.log("  2. npm install");
  console.log("  3. npx sfdx-devops-kit validate");
  console.log("  4. Add GitHub Secrets for each environment (see `validate` output).");
  return EXIT_OK;
}

function cmdValidate({ flags }) {
  const { config, file, errors, warnings } = loadConfig({ cwd: process.cwd(), file: flags.config });
  if (flags.json) {
    console.log(JSON.stringify({ file, ok: errors.length === 0, errors, warnings, config }, null, 2));
    return errors.length === 0 ? EXIT_OK : EXIT_GATE;
  }

  console.log(file ? `config: ${path.relative(process.cwd(), file) || file}` : "config: (not found)");
  for (const warning of warnings) console.log(`  ⚠ ${warning}`);
  for (const error of errors) console.log(`  ✖ ${error}`);

  if (errors.length > 0) {
    console.log(`\n${errors.length} error(s) — fix them before running the pipeline.`);
    return EXIT_GATE;
  }

  console.log(`  ✔ valid — ${Object.keys(config.environments).length} environment(s)`);
  console.log("\nRequired GitHub Secrets:");
  for (const key of Object.keys(config.environments)) {
    const env = resolveEnvironment(config, key);
    const plan = planPipeline(config, { env: key });
    console.log(`  ${plan.environment.auth_secret.padEnd(24)} → ${env.alias} (${env.type})`);
  }
  if (warnings.length > 0) console.log(`\n${warnings.length} warning(s) above are advisory.`);
  return EXIT_OK;
}

function cmdPlan({ flags }) {
  const config = requireConfig(flags);
  const plan = planPipeline(config, {
    env: flags.env,
    only: list(flags.only),
    skip: list(flags.skip),
  });

  if (flags.json) {
    console.log(JSON.stringify(plan, null, 2));
    return EXIT_OK;
  }

  console.log(`project: ${plan.project}`);
  console.log(
    `environment: ${plan.environment.key} → ${plan.environment.alias} ` +
      `(${plan.environment.type}, secret ${plan.environment.auth_secret})`,
  );
  const selector = plan.environment.selector;
  console.log(`deploy selector: ${selector ? `${selector.flag} ${selector.value}` : "(default package directories)"}`);
  console.log("");

  for (const stage of plan.stages) {
    const mark = stage.enabled ? "▶" : "·";
    const suffix = stage.enabled ? "" : ` — skipped: ${stage.skipped_because}`;
    console.log(`${mark} ${stage.id.padEnd(16)} ${stage.name}${suffix}`);
    if (!stage.enabled) continue;
    if (stage.gate) console.log(`    gate: ${stage.gate}`);
    for (const command of stage.commands) console.log(`    $ ${command}`);
  }
  return EXIT_OK;
}

function cmdRun({ positionals, flags }) {
  const config = requireConfig(flags);
  const only = positionals.length > 0 ? positionals : list(flags.only);
  for (const stage of only) {
    if (!STAGE_ORDER.includes(stage)) {
      console.error(`✖ Unknown stage "${stage}". Known stages: ${STAGE_ORDER.join(", ")}`);
      return EXIT_USAGE;
    }
  }

  const plan = planPipeline(config, { env: flags.env, only, skip: list(flags.skip) });
  const dryRun = Boolean(flags["dry-run"]);

  const outcome = runPipeline(plan, config, {
    cwd: process.cwd(),
    dryRun,
    onEvent: (event) => {
      if (flags.json) return;
      if (event.type === "start") console.log(`▶ ${event.stage.id}: ${event.stage.name}`);
      else if (event.type === "skip") console.log(`· ${event.stage.id}: skipped — ${event.message}`);
      else if (event.type === "pass") console.log(`  ✔ ${event.message}`);
      else if (event.type === "fail") console.log(`  ✖ ${event.message}`);
      else if (event.type === "abort") console.log(`  ⨯ ${event.message}`);
    },
  });

  if (flags.json) {
    console.log(JSON.stringify({ ok: outcome.ok, coverage: outcome.coverage, results: outcome.results }, null, 2));
  } else {
    const ran = outcome.results.filter((entry) => entry.status !== "skipped");
    if (dryRun) {
      // Nothing executed, so reporting "0/8 passed" would be misleading.
      console.log(`\n✔ ${ran.length} stage(s) planned — nothing was executed (--dry-run)`);
    } else {
      console.log(
        `\n${outcome.ok ? "✔ pipeline passed" : "✖ pipeline failed"} — ` +
          `${ran.filter((r) => r.status === "passed").length}/${ran.length} stage(s) passed` +
          (outcome.coverage !== null ? `, coverage ${outcome.coverage}%` : ""),
      );
    }
  }
  return outcome.ok ? EXIT_OK : EXIT_GATE;
}

function cmdDeliverables({ flags }) {
  const config = requireConfig(flags);
  const base = flags.base ?? "origin/main";
  const head = flags.head ?? "HEAD";

  let entries;
  try {
    entries = readDiff({ base, head, cwd: process.cwd() });
  } catch (error) {
    console.error(
      `✖ Could not read the diff ${base}...${head}: ${String(error.message).split("\n")[0]}\n` +
        "  Check the base ref exists locally (git fetch origin) or pass --base <ref>.",
    );
    return EXIT_USAGE;
  }

  const deliverables = deriveDeliverables(entries);
  const ticket = ticketContext(config, { cwd: process.cwd() });
  const includePr = config.backlog_integration?.deliverables?.include_pr_link !== false;
  const pullRequest = includePr
    ? resolvePullRequest({ cwd: process.cwd(), branch: ticket.branch, base })
    : null;
  const format = flags.format ?? "md";

  let output;
  if (format === "json") {
    output = JSON.stringify({ ...ticket, base, head, pull_request: pullRequest, ...deliverables }, null, 2);
  } else if (format === "package-xml") {
    output = renderPackageXml(deliverables, { apiVersion: flags["api-version"] });
  } else if (format === "md") {
    output = renderMarkdown(deliverables, {
      ticket: ticket.ticket,
      branch: ticket.branch,
      base,
      head,
      pull_request: pullRequest,
      format: flags["comment-format"] ?? config.backlog_integration?.comment_format ?? "markdown",
    });
  } else {
    console.error(`✖ Unknown --format "${format}" (expected md, json or package-xml).`);
    return EXIT_USAGE;
  }

  if (flags.out) {
    fs.mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
    fs.writeFileSync(path.resolve(flags.out), output, "utf8");
    console.log(`wrote ${deliverables.components.length} component(s) to ${flags.out}`);
  } else {
    process.stdout.write(output);
  }
  return EXIT_OK;
}

function cmdTicket({ flags }) {
  const config = requireConfig(flags);
  const context = ticketContext(config, { cwd: process.cwd(), branch: flags.branch });
  if (flags.json) {
    console.log(JSON.stringify(context, null, 2));
    return context.ticket ? EXIT_OK : EXIT_GATE;
  }

  console.log(`branch: ${context.branch || "(unknown)"}`);
  if (context.ticket) {
    console.log(`ticket: ${context.ticket}`);
  } else {
    console.log(`ticket: (unresolved) — ${context.unresolved_reason}`);
  }
  console.log("status mapping:");
  for (const [phase, status] of Object.entries(context.status_mapping)) {
    console.log(`  ${phase.padEnd(14)} → ${status}`);
  }
  return context.ticket ? EXIT_OK : EXIT_GATE;
}

/**
 * Print the exact Backlog MCP calls to make for this branch.
 *
 * No network access happens here: the kit holds no Backlog credentials. The
 * Claude Code skills take this plan and issue the calls through the Backlog MCP
 * server, which is where the API key lives.
 */
function cmdBacklog({ flags }) {
  const config = requireConfig(flags);
  const context = ticketContext(config, { cwd: process.cwd(), branch: flags.branch });
  const tools = backlogTools(config);
  const phase = flags.phase ?? "review_ready";

  let status;
  try {
    status = resolveStatus(config, phase);
  } catch (error) {
    console.error(`✖ ${error.message}`);
    return EXIT_USAGE;
  }

  let comment = "";
  let pullRequest = null;
  if (flags.comment === undefined || flags.comment) {
    const base = flags.base ?? "origin/main";
    try {
      const deliverables = deriveDeliverables(readDiff({ base, head: flags.head ?? "HEAD" }));
      pullRequest =
        config.backlog_integration?.deliverables?.include_pr_link !== false
          ? resolvePullRequest({ cwd: process.cwd(), branch: context.branch, base })
          : null;
      comment = renderMarkdown(deliverables, {
        ticket: context.ticket,
        branch: context.branch,
        base,
        head: flags.head ?? "HEAD",
        pull_request: pullRequest,
        format: flags["comment-format"] ?? config.backlog_integration?.comment_format ?? "markdown",
      });
    } catch (error) {
      comment = "";
      if (!flags.json) {
        console.error(`⚠ Could not build the deliverables comment: ${String(error.message).split("\n")[0]}`);
      }
    }
  }

  const calls = [];
  if (context.ticket) {
    calls.push({ tool: tools.getIssue, arguments: { issueKey: context.ticket } });
    if (comment) {
      calls.push({ tool: tools.addComment, arguments: { issueKey: context.ticket, content: comment } });
    }
    if (status.id !== null) {
      calls.push({ tool: tools.updateIssue, arguments: { issueKey: context.ticket, statusId: status.id } });
    }
  }

  const payload = {
    server: tools.server,
    ticket: context.ticket,
    pull_request: pullRequest,
    unresolved_reason: context.unresolved_reason,
    phase,
    status,
    calls,
  };

  if (flags.json) {
    console.log(JSON.stringify(payload, null, 2));
    return context.ticket && (status.id !== null || !flags["require-status"]) ? EXIT_OK : EXIT_GATE;
  }

  console.log(`MCP server: ${tools.server}`);
  console.log(`ticket:     ${context.ticket ?? `(unresolved) — ${context.unresolved_reason}`}`);
  if (pullRequest?.url) {
    console.log(
      `PR:         ${pullRequest.url}` +
        (pullRequest.source === "compare" ? "  (not opened yet — compare link)" : `  (${pullRequest.state})`),
    );
  }
  console.log(
    `status:     ${phase} → "${status.name}"` +
      (status.id === null
        ? "  ✖ id unknown — add backlog_integration.status_ids to change it"
        : `  (statusId ${status.id}, ${status.source})`),
  );
  console.log("\ncalls to make:");
  for (const call of calls) {
    const args = { ...call.arguments };
    if (typeof args.content === "string") args.content = `<${args.content.split("\n").length} line comment>`;
    console.log(`  ${call.tool}(${JSON.stringify(args)})`);
  }
  if (calls.length === 0) console.log("  (none — no ticket key resolved)");
  if (comment) {
    console.log("\ncomment body:\n");
    console.log(comment);
  }
  return context.ticket ? EXIT_OK : EXIT_GATE;
}

function cmdDoctor({ flags }) {
  const checks = [];
  const { config, file, errors, warnings } = loadConfig({ cwd: process.cwd(), file: flags.config });

  checks.push({ name: "node", ok: true, detail: process.version });
  checks.push({
    name: "sfdx-project.json",
    ok: fs.existsSync(path.join(process.cwd(), "sfdx-project.json")),
    detail: "SFDX project root",
  });
  checks.push({
    name: "config",
    ok: Boolean(config) && errors.length === 0,
    detail: file ? `${path.basename(file)} (${errors.length} error(s), ${warnings.length} warning(s))` : "not found",
  });

  // Code Analyzer's PMD/CPD/SFGE engines are Java-based; without a JDK they
  // cannot start and the analyzer reports engine errors instead of findings.
  if (config?.pipeline_settings?.code_analyzer?.enabled) {
    const java = spawnSync("java", ["-version"], { encoding: "utf8" });
    const ok = !java.error && java.status === 0;
    const version = /version "?([\d._]+)/.exec(`${java.stderr ?? ""}${java.stdout ?? ""}`)?.[1];
    checks.push({
      name: "java (Code Analyzer)",
      ok,
      optional: true,
      detail: ok
        ? `Java ${version ?? "detected"} — PMD/CPD/SFGE engines can start`
        : "not found — PMD/CPD/SFGE engines cannot start; install a JDK 11+ or select an engine that needs none (rule_selector: eslint)",
    });
  }

  // Backlog integration: the config file, the MCP registration and whether the
  // credentials are present in the environment. Values are never read or printed.
  if (config?.backlog_integration) {
    const mcpFile = path.join(process.cwd(), ".mcp.json");
    let registered = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(mcpFile, "utf8"));
      registered = Boolean(parsed.mcpServers?.[config.backlog_integration.mcp?.server_name ?? "backlog"]);
    } catch {
      registered = false;
    }
    checks.push({
      name: "backlog MCP",
      ok: registered,
      optional: true,
      detail: registered
        ? `.mcp.json registers "${config.backlog_integration.mcp?.server_name}"`
        : ".mcp.json does not register the Backlog MCP server (see the operations manual)",
    });

    // A comma-joined --enable-toolsets value matches no toolset and leaves the
    // server with zero tools, which looks like "Backlog is broken" rather than a
    // configuration mistake. Catch it here instead.
    if (registered) {
      let commaJoined = false;
      try {
        const parsed = JSON.parse(fs.readFileSync(mcpFile, "utf8"));
        const args = parsed.mcpServers[config.backlog_integration.mcp?.server_name ?? "backlog"].args ?? [];
        commaJoined = args.some(
          (arg, index) =>
            (arg === "--enable-toolsets" && String(args[index + 1] ?? "").includes(",")) ||
            /^--enable-toolsets=.*,/.test(String(arg)),
        );
      } catch {
        commaJoined = false;
      }
      checks.push({
        name: "backlog toolsets",
        ok: !commaJoined,
        optional: false,
        detail: commaJoined
          ? "--enable-toolsets uses a comma-separated value, which disables ALL tools; repeat the flag once per toolset"
          : "--enable-toolsets is passed correctly (or omitted)",
      });
    }
    const hasDomain = Boolean(process.env.BACKLOG_DOMAIN);
    const hasKey = Boolean(process.env.BACKLOG_API_KEY);
    checks.push({
      name: "backlog credentials",
      ok: hasDomain && hasKey,
      optional: true,
      detail: `BACKLOG_DOMAIN ${hasDomain ? "set" : "missing"}, BACKLOG_API_KEY ${hasKey ? "set" : "missing"}`,
    });
  }

  const detection = detectRtkSf({ python: config?.ai_assist?.rtk_sf?.python, cwd: process.cwd() });
  checks.push({
    name: "rtk-sf",
    ok: detection.installed,
    optional: config?.ai_assist?.rtk_sf?.required !== true,
    detail: detection.detail,
  });
  if (detection.installed) {
    checks.push({
      name: "rtk-sf index",
      ok: hasIndex(process.cwd()),
      optional: true,
      detail: hasIndex(process.cwd()) ? ".rtk-sf/specs present" : "not indexed yet",
    });
  }

  for (const check of checks) {
    const mark = check.ok ? "✔" : check.optional ? "⚠" : "✖";
    console.log(`${mark} ${check.name.padEnd(18)} ${check.detail}`);
  }
  console.log(`\n${rtkAdvice(detection)}`);

  const blocking = checks.filter((check) => !check.ok && !check.optional);
  return blocking.length === 0 ? EXIT_OK : EXIT_GATE;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireConfig(flags) {
  const { config, errors } = loadConfig({ cwd: process.cwd(), file: flags.config });
  if (!config || errors.length > 0) {
    const detail = errors.map((error) => `  ✖ ${error}`).join("\n");
    throw new Error(`Configuration is not usable:\n${detail}\n  Run \`sfdx-devops-kit validate\` for details.`);
  }
  return config;
}

function report(label, items) {
  if (items.length === 0) return;
  console.log(`  ${label}: ${items.length}`);
  for (const item of items) console.log(`    - ${item}`);
}

function list(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  let command = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const [name, inline] = token.slice(2).split("=");
      if (inline !== undefined) {
        flags[name] = inline;
      } else if (argv[index + 1] && !argv[index + 1].startsWith("-")) {
        flags[name] = argv[index + 1];
        index += 1;
      } else {
        flags[name] = true;
      }
    } else if (token === "-h") {
      flags.help = true;
    } else if (token === "-v") {
      flags.version = true;
    } else if (!command) {
      command = token;
    } else {
      positionals.push(token);
    }
  }

  return { command, positionals, flags };
}

function usage() {
  return `sfdx-devops-kit ${pkg.version} — configuration-driven pipeline for Salesforce DX

USAGE
  sfdx-devops-kit <command> [options]

COMMANDS
  init [dir]        Install pipeline, CI workflow, Claude skills and knowledge base
  validate          Validate sfdx-pipeline.config.yml and list required GitHub Secrets
  plan              Show the resolved pipeline (which stages run, with what commands)
  run [stage...]    Execute the pipeline, or only the named stages
  deliverables      List the metadata a ticket delivered (Backlog comment / package.xml)
  ticket            Resolve the Backlog ticket key from the current branch
  backlog           Print the exact Backlog MCP calls for this branch
  doctor            Check the local toolchain, config and rtk-sf integration

OPTIONS
  --env <key>          Target environment key (default: the is_test_target one)
  --only a,b           Run only these stages
  --skip a,b           Exclude these stages
  --dry-run            Print what would run without executing or writing
  --force              Overwrite existing files (init)
  --project-name <n>   Project name substituted into templates (init)
  --base <ref>         Diff base for deliverables (default: origin/main)
  --head <ref>         Diff head for deliverables (default: HEAD)
  --format <f>         deliverables output: md | json | package-xml
  --comment-format <f> Backlog comment dialect: markdown (default) | backlog
  --out <file>         Write output to a file instead of stdout
  --phase <p>          Backlog phase (backlog command): in_progress | review_ready | closed
  --config <file>      Use a specific config file
  --json               Machine-readable output
  -h, --help           This help
  -v, --version        Version

STAGES
  ${STAGE_ORDER.join(", ")}

EXAMPLES
  sfdx-devops-kit init .
  sfdx-devops-kit validate
  sfdx-devops-kit plan --env st
  sfdx-devops-kit run --env st --dry-run
  sfdx-devops-kit run code_analyzer unit_test
  sfdx-devops-kit deliverables --base origin/develop --format package-xml --out manifest/ticket.xml

Documentation: ${pkg.homepage}`;
}
