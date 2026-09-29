/**
 * stages.mjs — turn a validated config into an ordered, executable plan.
 *
 * The plan is the contract between this kit's three consumers: the local CLI
 * runs it, GitHub Actions reads it as JSON to decide which steps to execute,
 * and the Claude Code skills quote it when explaining what CI will do.
 *
 * Every stage reports why it is enabled or skipped, so `plan` doubles as the
 * explanation of a pipeline rather than just its execution list.
 */

import {
  authSecretName,
  deploySelector,
  resolveEnvironment,
  STAGE_ORDER,
} from "./config.mjs";

/**
 * Build the pipeline plan.
 *
 * @param {object} config validated config
 * @param {{env?: string, only?: string[], skip?: string[]}} options
 * @returns {{project: string, environment: object, stages: object[]}}
 */
export function planPipeline(config, { env, only = [], skip = [] } = {}) {
  const environment = resolveEnvironment(config, env);
  const settings = config.pipeline_settings ?? {};
  const rtk = config.ai_assist?.rtk_sf ?? {};

  const stages = STAGE_ORDER.map((id) => {
    const stage = settings[id] ?? { enabled: false };
    const builder = BUILDERS[id];
    const built = builder ? builder({ config, stage, environment, rtk }) : { commands: [] };

    let enabled = stage.enabled === true;
    let skipped_because = enabled ? null : `pipeline_settings.${id}.enabled is false`;

    if (enabled && built.requires_rtk_sf && !rtk.enabled) {
      enabled = false;
      skipped_because = "ai_assist.rtk_sf.enabled is false";
    }
    if (enabled && only.length > 0 && !only.includes(id)) {
      enabled = false;
      skipped_because = `not selected by --only ${only.join(",")}`;
    }
    if (enabled && skip.includes(id)) {
      enabled = false;
      skipped_because = `excluded by --skip ${skip.join(",")}`;
    }

    return {
      id,
      name: built.name ?? id,
      enabled,
      skipped_because,
      gate: built.gate ?? null,
      requires_rtk_sf: Boolean(built.requires_rtk_sf),
      // A stage may keep running when it fails, if fail_on_error is false.
      fail_on_error: stage.fail_on_error !== false,
      commands: built.commands ?? [],
      ...(built.extra ?? {}),
    };
  });

  // A flat map so GitHub Actions can gate a step with a single expression:
  //   if: fromJSON(needs.plan.outputs.plan).enabled.code_analyzer
  const enabled = Object.fromEntries(stages.map((stage) => [stage.id, stage.enabled]));

  return {
    project: config.project_name,
    enabled,
    environment: {
      key: environment.key,
      alias: environment.alias,
      type: environment.type,
      auth_secret: authSecretName(environment),
      selector: deploySelector(environment),
    },
    stages,
  };
}

/** Convenience: the stages that will actually run. */
export function enabledStages(plan) {
  return plan.stages.filter((stage) => stage.enabled);
}

const BUILDERS = {
  lint: ({ stage }) => ({
    name: "Lint (ESLint)",
    commands: [stage.command || "npm run lint"],
  }),

  prettier: ({ stage }) => ({
    name: "Format check (Prettier)",
    commands: [stage.command || "npm run prettier"],
  }),

  code_analyzer: ({ stage }) => ({
    name: "Salesforce Code Analyzer",
    gate: `fails on any violation at severity <= ${stage.severity_threshold}`,
    commands: [analyzerCommand(stage)],
    extra: {
      engine: stage.engine,
      severity_threshold: stage.severity_threshold,
      output_file: stage.output_file,
    },
  }),

  validate_deploy: ({ config, environment }) => {
    const unit = config.pipeline_settings.unit_test ?? {};
    return {
      name: `Validation deploy to ${environment.alias} (dry run)`,
      gate: "deployment must validate without component errors",
      commands: [
        deployCommand({ environment, unit, dryRun: true }),
      ],
    };
  },

  unit_test: ({ config, stage }) => ({
    name: "Apex unit tests and coverage gate",
    gate: `org-wide coverage must reach ${stage.coverage_threshold}%`,
    commands: [],
    extra: {
      test_level: stage.test_level,
      tests: stage.tests ?? [],
      coverage_threshold: stage.coverage_threshold,
      // Coverage comes from the validation deploy's JSON, so this stage is a
      // gate over that result rather than a second deployment.
      reads_result_of: config.pipeline_settings.validate_deploy?.enabled === false
        ? "deploy"
        : "validate_deploy",
    },
  }),

  deploy: ({ config, environment }) => {
    const unit = config.pipeline_settings.unit_test ?? {};
    return {
      name: `Deploy to ${environment.alias}`,
      gate: "deployment must succeed",
      commands: [deployCommand({ environment, unit, dryRun: false })],
    };
  },

  integration_test: ({ stage }) => ({
    name: "Integration tests",
    commands: [
      stage.tool === "newman"
        ? stage.command || "npx newman run tests/integration/collection.json"
        : stage.command,
    ].filter(Boolean),
  }),

  e2e_test: ({ stage }) => ({
    name: "E2E tests",
    commands: [
      stage.tool === "playwright"
        ? stage.command || "npx playwright test"
        : stage.command,
    ].filter(Boolean),
  }),

  documentation: ({ stage, rtk }) => ({
    name: "Generate system documentation (rtk-sf)",
    requires_rtk_sf: true,
    commands: [
      `${rtk.python || "python3"} -m rtk_sf index`,
      `${rtk.python || "python3"} -m rtk_sf docs ${stage.doc_type || "all"} --output-dir ${stage.output_dir || "docs"}`,
    ],
    extra: { doc_type: stage.doc_type, output_dir: stage.output_dir },
  }),
};

function analyzerCommand(stage) {
  if (stage.engine === "scanner") {
    // Legacy @salesforce/sfdx-scanner (sf scanner run).
    const parts = [
      "sf scanner run",
      `--target ${quote(stage.target || "force-app")}`,
      "--format json",
      `--outfile ${quote(stage.output_file || "code-analyzer-results.json")}`,
      `--severity-threshold ${stage.severity_threshold}`,
    ];
    if (stage.pmd_rule_set) parts.push(`--pmdconfig ${quote(stage.pmd_rule_set)}`);
    return parts.join(" ");
  }

  // Code Analyzer v5 (sf code-analyzer run). Rule selection is a selector
  // expression; a PMD ruleset file is supplied through --config-file instead.
  const parts = [
    "sf code-analyzer run",
    `--workspace ${quote(stage.target || "force-app")}`,
    `--rule-selector ${quote(stage.rule_selector || "Recommended")}`,
    `--severity-threshold ${stage.severity_threshold}`,
    `--output-file ${quote(stage.output_file || "code-analyzer-results.json")}`,
    "--view detail",
  ];
  if (stage.config_file) parts.push(`--config-file ${quote(stage.config_file)}`);
  return parts.join(" ");
}

function deployCommand({ environment, unit, dryRun }) {
  const parts = ["sf project deploy start", "--json", `--target-org ${quote(environment.alias)}`];

  // Exactly one selector — the CLI rejects --manifest/--source-dir/--metadata
  // in combination, and config validation already enforces the same rule.
  const selector = deploySelector(environment);
  if (selector) {
    const value = Array.isArray(selector.value) ? selector.value : [selector.value];
    for (const item of value) parts.push(`${selector.flag} ${quote(item)}`);
  }

  const level = unit.enabled === false ? "NoTestRun" : unit.test_level || "RunLocalTests";
  parts.push(`--test-level ${level}`);
  if (level === "RunSpecifiedTests") {
    for (const test of unit.tests ?? []) parts.push(`--tests ${quote(test)}`);
  }
  if (dryRun) parts.push("--dry-run");
  parts.push("--wait 60");
  return parts.join(" ");
}

function quote(value) {
  const text = String(value);
  return /^[\w./:@-]+$/.test(text) ? text : JSON.stringify(text);
}

export { analyzerCommand, deployCommand };
