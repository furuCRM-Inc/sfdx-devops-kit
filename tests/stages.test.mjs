/**
 * The plan is what CI executes, so the commands it emits must be exactly what
 * the Salesforce CLI accepts — a wrong flag here breaks every consumer's build.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { validateConfig } from "../src/config.mjs";
import { analyzerCommand, deployCommand, enabledStages, planPipeline } from "../src/stages.mjs";

function configure(overrides = {}) {
  const { config, errors } = validateConfig({
    version: "1.0",
    project_name: "demo",
    environments: {
      st: { alias: "STSandbox", type: "sandbox", is_test_target: true },
      prod: { alias: "Production", type: "production", deploy_manifest: "manifest/package.xml" },
    },
    backlog_integration: { project_key: "DEMO" },
    ...overrides,
  });
  assert.deepEqual(errors, [], `fixture config should be valid: ${errors.join("; ")}`);
  return config;
}

function stage(plan, id) {
  const found = plan.stages.find((entry) => entry.id === id);
  assert.ok(found, `plan should contain stage ${id}`);
  return found;
}

test("the plan keeps the documented stage order", () => {
  const plan = planPipeline(configure());
  assert.deepEqual(
    plan.stages.map((entry) => entry.id),
    [
      "lint",
      "prettier",
      "code_analyzer",
      "validate_deploy",
      "unit_test",
      "deploy",
      "integration_test",
      "e2e_test",
      "documentation",
    ],
  );
});

test("the environment resolves with its secret name and selector", () => {
  const plan = planPipeline(configure());
  assert.equal(plan.environment.key, "st");
  assert.equal(plan.environment.auth_secret, "SF_ST_AUTH_URL");
  assert.equal(plan.environment.selector, null);

  const prod = planPipeline(configure(), { env: "prod" });
  assert.equal(prod.environment.auth_secret, "SF_PROD_AUTH_URL");
  assert.deepEqual(prod.environment.selector, {
    flag: "--manifest",
    value: "manifest/package.xml",
  });
});

test("a disabled stage says why it is skipped", () => {
  const plan = planPipeline(
    configure({ pipeline_settings: { e2e_test: { enabled: false } } }),
  );
  const e2e = stage(plan, "e2e_test");
  assert.equal(e2e.enabled, false);
  assert.match(e2e.skipped_because, /pipeline_settings\.e2e_test\.enabled is false/);
});

test("--only and --skip narrow the plan and record the reason", () => {
  const only = planPipeline(configure(), { only: ["lint"] });
  assert.deepEqual(enabledStages(only).map((entry) => entry.id), ["lint"]);
  assert.match(stage(only, "deploy").skipped_because, /--only lint/);

  const skipped = planPipeline(configure(), { skip: ["deploy", "e2e_test"] });
  const ids = enabledStages(skipped).map((entry) => entry.id);
  assert.ok(!ids.includes("deploy") && !ids.includes("e2e_test"));
  assert.match(stage(skipped, "deploy").skipped_because, /--skip/);
});

test("the flat enabled map matches the stage list, for GitHub Actions expressions", () => {
  const plan = planPipeline(configure({ pipeline_settings: { prettier: { enabled: false } } }));
  assert.equal(plan.enabled.lint, true);
  assert.equal(plan.enabled.prettier, false);
  for (const entry of plan.stages) {
    assert.equal(plan.enabled[entry.id], entry.enabled);
  }
});

test("documentation is planned but marked as requiring rtk-sf", () => {
  const plan = planPipeline(configure());
  const docs = stage(plan, "documentation");
  assert.equal(docs.enabled, true, "rtk-sf integration is on by default");
  assert.equal(docs.requires_rtk_sf, true);
  assert.ok(docs.commands.some((command) => command.includes("rtk_sf docs all")));
  assert.ok(docs.commands.some((command) => command.includes("rtk_sf index")));
});

test("disabling rtk-sf skips its stages with a config-level reason", () => {
  const plan = planPipeline(configure({ ai_assist: { rtk_sf: { enabled: false } } }));
  const docs = stage(plan, "documentation");
  assert.equal(docs.enabled, false);
  assert.match(docs.skipped_because, /ai_assist\.rtk_sf\.enabled is false/);
});

test("the deploy command never combines mutually exclusive selectors", () => {
  const command = deployCommand({
    environment: { alias: "STSandbox", deploy_manifest: "manifest/package.xml", source_dir: "force-app" },
    unit: { enabled: true, test_level: "RunLocalTests" },
    dryRun: true,
  });
  assert.ok(command.includes("--manifest manifest/package.xml"));
  assert.ok(!command.includes("--source-dir"), "only one selector may reach the CLI");
  assert.ok(command.includes("--dry-run"));
  assert.ok(command.includes("--json"));
});

test("RunSpecifiedTests passes each test class through --tests", () => {
  const command = deployCommand({
    environment: { alias: "STSandbox" },
    unit: { enabled: true, test_level: "RunSpecifiedTests", tests: ["AT", "BT"] },
    dryRun: false,
  });
  assert.ok(command.includes("--test-level RunSpecifiedTests"));
  assert.ok(command.includes("--tests AT"));
  assert.ok(command.includes("--tests BT"));
});

test("a disabled unit_test stage deploys with NoTestRun", () => {
  const command = deployCommand({
    environment: { alias: "STSandbox" },
    unit: { enabled: false, test_level: "RunLocalTests" },
    dryRun: false,
  });
  assert.ok(command.includes("--test-level NoTestRun"));
});

test("values needing quotes are quoted", () => {
  const command = deployCommand({
    environment: { alias: "My Sandbox", source_dir: "force-app/main/default" },
    unit: { enabled: true, test_level: "RunLocalTests" },
    dryRun: false,
  });
  assert.ok(command.includes('--target-org "My Sandbox"'));
  assert.ok(command.includes("--source-dir force-app/main/default"));
});

test("the analyzer command matches Code Analyzer v5 flags", () => {
  const command = analyzerCommand({
    engine: "code-analyzer",
    target: "force-app",
    rule_selector: "Recommended",
    severity_threshold: 3,
    output_file: "code-analyzer-results.json",
  });
  assert.ok(command.startsWith("sf code-analyzer run"));
  for (const flag of ["--workspace force-app", "--rule-selector Recommended",
    "--severity-threshold 3", "--output-file code-analyzer-results.json", "--view detail"]) {
    assert.ok(command.includes(flag), `expected ${flag} in: ${command}`);
  }
  // v5 has no --json flag; results come from the output file.
  assert.ok(!command.includes("--json"));
});

test("the legacy scanner engine emits its own flags", () => {
  const command = analyzerCommand({
    engine: "scanner",
    target: "force-app",
    severity_threshold: 2,
    pmd_rule_set: "category/apex/bestpractices.xml",
    output_file: "out.json",
  });
  assert.ok(command.startsWith("sf scanner run"));
  assert.ok(command.includes("--format json"));
  assert.ok(command.includes("--outfile out.json"));
  assert.ok(command.includes("--pmdconfig category/apex/bestpractices.xml"));
  assert.ok(!command.includes("--workspace"), "v5-only flags must not leak into the legacy engine");
});

test("the coverage gate reads the validation deploy rather than redeploying", () => {
  const plan = planPipeline(configure());
  const unit = stage(plan, "unit_test");
  assert.deepEqual(unit.commands, [], "the gate must not run its own deployment");
  assert.equal(unit.reads_result_of, "validate_deploy");
  assert.match(unit.gate, /75%/);

  const noValidation = planPipeline(
    configure({ pipeline_settings: { validate_deploy: { enabled: false } } }),
  );
  assert.equal(stage(noValidation, "unit_test").reads_result_of, "deploy");
});

test("a custom E2E command replaces the Playwright default", () => {
  const plan = planPipeline(
    configure({
      pipeline_settings: { e2e_test: { enabled: true, tool: "custom", command: "make e2e" } },
    }),
  );
  assert.deepEqual(stage(plan, "e2e_test").commands, ["make e2e"]);
});
