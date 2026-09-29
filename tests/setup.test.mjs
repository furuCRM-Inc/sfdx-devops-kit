/**
 * The setup wizard's decisions.
 *
 * The config file is meant to be read and edited by people, so the wizard must
 * rewrite it surgically: comments, key order and unrelated sections survive.
 * And a credential must never end up inside the project — the Backlog key goes
 * to a file in the home directory, and auth URLs only ever travel on stdin.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { load as parseYaml } from "js-yaml";

import { validateConfig } from "../src/config.mjs";
import { TEMPLATE_ROOT } from "../src/scaffold.mjs";
import {
  backlogEnvContents,
  normalizeBacklogDomain,
  planCredentials,
  renderEnvironmentsBlock,
  setScalar,
  setTopLevelScalar,
  suggestEnvironment,
  upsertEnvironments,
  validateBacklogKey,
} from "../src/setup.mjs";

const TEMPLATE = fs.readFileSync(
  path.join(TEMPLATE_ROOT, "config/sfdx-pipeline.config.yml"),
  "utf8",
);

const THREE = [
  { key: "dev", alias: "DevSandbox", type: "sandbox" },
  { key: "st", alias: "STSandbox", type: "sandbox", is_test_target: true },
  { key: "prod", alias: "Production", type: "production", deploy_manifest: "manifest/package.xml" },
];

// ---------------------------------------------------------------------------
// Rewriting the config
// ---------------------------------------------------------------------------

test("the rewritten config is valid YAML and passes validation", () => {
  const updated = upsertEnvironments(TEMPLATE, THREE);
  const parsed = parseYaml(updated);

  assert.deepEqual(Object.keys(parsed.environments), ["dev", "st", "prod"]);
  assert.equal(parsed.environments.st.is_test_target, true);
  assert.equal(parsed.environments.prod.deploy_manifest, "manifest/package.xml");

  const { errors } = validateConfig(parsed);
  assert.deepEqual(errors, [], `rewritten config should validate: ${errors.join("; ")}`);
});

test("comments and unrelated sections survive the rewrite", () => {
  const updated = upsertEnvironments(TEMPLATE, THREE);

  assert.ok(updated.includes("# sfdx-pipeline.config.yml"), "the file header stays");
  assert.ok(
    updated.includes("# Pipeline stages, in execution order"),
    "the pipeline_settings comment block stays",
  );
  assert.ok(updated.includes("severity_threshold: 3"), "unrelated settings stay");
  assert.ok(updated.includes("backlog_integration:"), "later sections stay");

  // The old environments must be gone, not merged with the new ones.
  assert.ok(!updated.includes("UATSandbox"), "the replaced block should not linger");
});

test("rewriting twice is stable", () => {
  const once = upsertEnvironments(TEMPLATE, THREE);
  const twice = upsertEnvironments(once, THREE);
  assert.equal(parseYaml(twice).environments.st.alias, "STSandbox");
  assert.deepEqual(Object.keys(parseYaml(twice).environments), ["dev", "st", "prod"]);
});

test("a config with no environments block gets one before pipeline_settings", () => {
  const bare = 'version: "1.0"\nproject_name: "demo"\n\npipeline_settings:\n  lint:\n    enabled: true\n';
  const updated = upsertEnvironments(bare, [{ key: "st", alias: "A", type: "sandbox", is_test_target: true }]);
  const parsed = parseYaml(updated);

  assert.equal(parsed.environments.st.alias, "A");
  assert.equal(parsed.pipeline_settings.lint.enabled, true);
  assert.ok(updated.indexOf("environments:") < updated.indexOf("pipeline_settings:"));
});

test("a key that is not a bare YAML word is quoted", () => {
  const block = renderEnvironmentsBlock([{ key: "pre-prod", alias: "PreProd", type: "sandbox" }]);
  assert.match(block, /^ {2}"pre-prod":$/m);
  assert.equal(parseYaml(block).environments["pre-prod"].alias, "PreProd");
});

test("only one deployment selector is written", () => {
  const block = renderEnvironmentsBlock([
    {
      key: "prod",
      alias: "P",
      type: "production",
      deploy_manifest: "manifest/package.xml",
      source_dir: "force-app",
    },
  ]);
  assert.ok(block.includes("deploy_manifest"));
  assert.ok(!block.includes("source_dir"), "the CLI rejects two selectors together");
});

test("scalars are replaced without disturbing their comments", () => {
  const withName = setTopLevelScalar(TEMPLATE, "project_name", "acme-crm");
  assert.match(withName, /^project_name: "acme-crm"$/m);

  const withKey = setScalar(withName, "backlog_integration.project_key", "ACME");
  assert.match(withKey, /^ {2}project_key: "ACME"$/m);
  assert.equal(parseYaml(withKey).backlog_integration.project_key, "ACME");

  // The branch_pattern line carries a trailing comment that must be preserved.
  const withPattern = setScalar(withKey, "backlog_integration.branch_pattern", "([A-Z]+-\\d+)");
  assert.match(withPattern, /branch_pattern: .*# matches/);
});

// ---------------------------------------------------------------------------
// Suggestions from the orgs the CLI already knows
// ---------------------------------------------------------------------------

test("an org's alias suggests its environment key and type", () => {
  assert.deepEqual(suggestEnvironment({ alias: "MyDevSandbox" }), {
    key: "dev",
    type: "sandbox",
    alias: "MyDevSandbox",
  });
  assert.equal(suggestEnvironment({ alias: "UAT-Box" }).key, "uat");
  assert.equal(suggestEnvironment({ alias: "Production" }).type, "production");
  assert.equal(suggestEnvironment({ alias: "Production" }).key, "prod");
});

test("a production-looking sandbox is not typed as production", () => {
  const suggestion = suggestEnvironment({ alias: "prod-sandbox" });
  assert.equal(suggestion.type, "sandbox", "a sandbox copy of production is still a sandbox");
});

test("a scratch org is recognised by its expiry", () => {
  assert.equal(suggestEnvironment({ alias: "temp", expirationDate: "2026-10-01" }).type, "scratch");
});

test("an org with no alias falls back to its username", () => {
  const suggestion = suggestEnvironment({ username: "test-abc@example.com" });
  assert.equal(suggestion.alias, "test-abc@example.com");
  assert.match(suggestion.key, /^[a-z0-9_-]+$/);
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

test("credential planning reports what is missing per environment", () => {
  const plans = planCredentials(
    THREE,
    new Set(["DevSandbox", "STSandbox"]),
    new Set(["SF_DEV_AUTH_URL"]),
  );

  assert.deepEqual(plans.map((p) => p.secret), [
    "SF_DEV_AUTH_URL",
    "SF_ST_AUTH_URL",
    "SF_PROD_AUTH_URL",
  ]);
  assert.deepEqual(plans.map((p) => p.authorized), [true, true, false]);
  assert.deepEqual(plans.map((p) => p.secretPresent), [true, false, false]);
});

test("the Backlog credentials file stays outside the project and carries no surprises", () => {
  const contents = backlogEnvContents("acme.backlog.com", "A".repeat(64));
  assert.match(contents, /^export BACKLOG_DOMAIN=acme\.backlog\.com$/m);
  assert.match(contents, /^export BACKLOG_API_KEY=A{64}$/m);
  assert.match(contents, /Keep this file at mode 600/);
});

test("a pasted Backlog domain is normalized", () => {
  assert.equal(normalizeBacklogDomain("https://acme.backlog.com/"), "acme.backlog.com");
  assert.equal(normalizeBacklogDomain("  ACME.backlog.jp/projects/X "), "acme.backlog.jp");
});

test("a key pasted with its surrounding prose is rejected, not stored", () => {
  // Exactly the mistake seen in practice: the key plus an explanatory phrase.
  const withProse = validateBacklogKey("bPSRimIguT5PaI4OY0N1RkLyKKDIQlvEVkNXXjtHJymAvWipZVE8sdm47P4hGRj5（先ほどの鍵）");
  assert.equal(withProse.ok, false);
  assert.match(withProse.reason, /英数字以外/);

  const placeholder = validateBacklogKey("ここに64文字の鍵");
  assert.equal(placeholder.ok, false);

  const short = validateBacklogKey("abc123");
  assert.equal(short.ok, false);
  assert.match(short.reason, /短すぎます/);

  const good = validateBacklogKey(`  ${"a1B2".repeat(16)}  `);
  assert.equal(good.ok, true);
  assert.equal(good.value.length, 64);
});
