/**
 * Config validation is the kit's safety net: a bad threshold or an impossible
 * flag combination must fail here, not halfway through a deployment.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  authSecretName,
  deploySelector,
  findConfigFile,
  loadConfig,
  resolveEnvironment,
  validateConfig,
} from "../src/config.mjs";

/** Minimal valid config; tests override just the part they exercise. */
function base(overrides = {}) {
  return {
    version: "1.0",
    project_name: "demo",
    environments: {
      st: { alias: "STSandbox", type: "sandbox", is_test_target: true },
      prod: { alias: "Production", type: "production" },
    },
    backlog_integration: { project_key: "DEMO" },
    ...overrides,
  };
}

test("a minimal config validates and receives defaults", () => {
  const { config, errors } = validateConfig(base());
  assert.deepEqual(errors, []);
  assert.equal(config.pipeline_settings.unit_test.test_level, "RunLocalTests");
  assert.equal(config.pipeline_settings.unit_test.coverage_threshold, 75);
  assert.equal(config.pipeline_settings.code_analyzer.engine, "code-analyzer");
});

test("rtk-sf is integrated by default but not required", () => {
  const { config } = validateConfig(base());
  assert.equal(config.ai_assist.rtk_sf.enabled, true, "rtk-sf should default to enabled");
  assert.equal(config.ai_assist.rtk_sf.required, false, "a missing rtk-sf must not fail a build");
  assert.equal(config.pipeline_settings.documentation.enabled, true);
  assert.equal(config.pipeline_settings.documentation.tool, "rtk-sf");
});

test("user settings override defaults without erasing siblings", () => {
  const { config, errors } = validateConfig(
    base({
      pipeline_settings: { unit_test: { coverage_threshold: 90 } },
    }),
  );
  assert.deepEqual(errors, []);
  assert.equal(config.pipeline_settings.unit_test.coverage_threshold, 90);
  // Untouched keys keep their defaults rather than disappearing.
  assert.equal(config.pipeline_settings.unit_test.test_level, "RunLocalTests");
  assert.equal(config.pipeline_settings.lint.enabled, true);
});

test("an unsupported version is rejected", () => {
  const { errors } = validateConfig(base({ version: "2.0" }));
  assert.ok(errors.some((error) => error.includes("version")));
});

test("environments must declare an alias and a valid type", () => {
  const { errors } = validateConfig(
    base({ environments: { st: { type: "playground", is_test_target: true } } }),
  );
  assert.ok(errors.some((error) => error.includes("environments.st.alias")));
  assert.ok(errors.some((error) => error.includes("environments.st.type")));
});

test("combining deployment selectors is rejected with the CLI's reason", () => {
  const { errors } = validateConfig(
    base({
      environments: {
        st: {
          alias: "STSandbox",
          type: "sandbox",
          is_test_target: true,
          deploy_manifest: "manifest/package.xml",
          source_dir: "force-app",
        },
      },
    }),
  );
  const message = errors.find((error) => error.includes("deploy_manifest"));
  assert.ok(message, "expected an error naming the conflicting selectors");
  assert.match(message, /rejects those flags together/);
});

test("exactly one test target is allowed", () => {
  const two = validateConfig(
    base({
      environments: {
        st: { alias: "A", type: "sandbox", is_test_target: true },
        uat: { alias: "B", type: "sandbox", is_test_target: true },
      },
    }),
  );
  assert.ok(two.errors.some((error) => error.includes("is_test_target")));

  const none = validateConfig(
    base({ environments: { dev: { alias: "A", type: "sandbox" } } }),
  );
  assert.deepEqual(none.errors, []);
  assert.ok(none.warnings.some((warning) => warning.includes("is_test_target")));
});

test("production cannot be the test target", () => {
  const { errors } = validateConfig(
    base({
      environments: { prod: { alias: "P", type: "production", is_test_target: true } },
    }),
  );
  assert.ok(errors.some((error) => error.includes("must not be set on a production")));
});

test("RunSpecifiedTests requires a test list", () => {
  const missing = validateConfig(
    base({ pipeline_settings: { unit_test: { test_level: "RunSpecifiedTests" } } }),
  );
  assert.ok(missing.errors.some((error) => error.includes("RunSpecifiedTests")));

  const provided = validateConfig(
    base({
      pipeline_settings: {
        unit_test: { test_level: "RunSpecifiedTests", tests: ["OrderServiceTest"] },
      },
    }),
  );
  assert.deepEqual(provided.errors, []);
});

test("NoTestRun with the stage enabled warns that coverage cannot be checked", () => {
  const { errors, warnings } = validateConfig(
    base({ pipeline_settings: { unit_test: { test_level: "NoTestRun" } } }),
  );
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((warning) => warning.includes("NoTestRun")));
});

test("thresholds are range-checked", () => {
  const coverage = validateConfig(
    base({ pipeline_settings: { unit_test: { coverage_threshold: 150 } } }),
  );
  assert.ok(coverage.errors.some((error) => error.includes("coverage_threshold")));

  const severity = validateConfig(
    base({ pipeline_settings: { code_analyzer: { severity_threshold: 9 } } }),
  );
  assert.ok(severity.errors.some((error) => error.includes("severity_threshold")));
});

test("a custom tool without a command is rejected", () => {
  const { errors } = validateConfig(
    base({
      pipeline_settings: {
        e2e_test: { enabled: true, tool: "custom", command: "" },
        integration_test: { enabled: true, tool: "custom", command: "" },
      },
    }),
  );
  assert.equal(errors.filter((error) => error.includes("`custom`")).length, 2);
});

test("an unknown stage is reported as ignored rather than silently dropped", () => {
  const { warnings } = validateConfig(
    base({ pipeline_settings: { smoke_test: { enabled: true } } }),
  );
  assert.ok(warnings.some((warning) => warning.includes("smoke_test")));
});

test("an invalid branch pattern is caught before the review skill uses it", () => {
  const { errors } = validateConfig(
    base({ backlog_integration: { project_key: "DEMO", branch_pattern: "([A-Z" } }),
  );
  assert.ok(errors.some((error) => error.includes("branch_pattern")));
});

test("documentation enabled with rtk-sf disabled warns about the skip", () => {
  const { warnings } = validateConfig(
    base({ ai_assist: { rtk_sf: { enabled: false } } }),
  );
  assert.ok(warnings.some((warning) => warning.includes("documentation")));
});

test("resolveEnvironment falls back to the test target and reports unknown keys", () => {
  const { config } = validateConfig(base());
  assert.equal(resolveEnvironment(config).key, "st");
  assert.equal(resolveEnvironment(config, "prod").alias, "Production");
  assert.throws(() => resolveEnvironment(config, "nope"), /Unknown environment "nope"/);
});

test("secret names derive from the environment key unless overridden", () => {
  assert.equal(authSecretName({ key: "st" }), "SF_ST_AUTH_URL");
  assert.equal(authSecretName({ key: "pre-prod" }), "SF_PRE_PROD_AUTH_URL");
  assert.equal(authSecretName({ key: "st", auth_secret: "MY_SECRET" }), "MY_SECRET");
});

test("deploySelector picks one flag, preferring an explicit manifest", () => {
  assert.deepEqual(deploySelector({ deploy_manifest: "m/package.xml", source_dir: "force-app" }), {
    flag: "--manifest",
    value: "m/package.xml",
  });
  assert.deepEqual(deploySelector({ source_dir: "force-app" }), {
    flag: "--source-dir",
    value: "force-app",
  });
  assert.equal(deploySelector({}), null);
});

test("loadConfig finds the file by walking up, and reports a missing one", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(root, "sfdx-pipeline.config.yml"),
    "version: '1.0'\nproject_name: walked\nenvironments:\n  st:\n    alias: A\n    type: sandbox\n    is_test_target: true\n",
  );
  const nested = path.join(root, "a", "b");
  fs.mkdirSync(nested, { recursive: true });

  assert.equal(findConfigFile(nested), path.join(root, "sfdx-pipeline.config.yml"));
  const { config, errors } = loadConfig({ cwd: nested });
  assert.deepEqual(errors, []);
  assert.equal(config.project_name, "walked");

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-empty-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const missing = loadConfig({ cwd: empty });
  assert.equal(missing.config, null);
  assert.match(missing.errors[0], /not found/);
});

test("invalid YAML is reported as YAML, not as a crash", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-yaml-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "sfdx-pipeline.config.yml"), "version: '1.0'\n  bad: [indent\n");

  const { config, errors } = loadConfig({ cwd: root });
  assert.equal(config, null);
  assert.match(errors[0], /not valid YAML/);
});
