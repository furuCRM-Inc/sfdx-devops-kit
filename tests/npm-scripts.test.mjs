/**
 * The gate commands must actually gate.
 *
 * These cases come from a project generated with `sf project generate
 * --template standard`: its `prettier` script formats rather than checks, and
 * its `lint` script fails on an empty glob.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { validateConfig } from "../src/config.mjs";
import { auditGateCommands, parseNpmRun } from "../src/npm-scripts.mjs";
import { PACKAGE_SCRIPTS } from "../src/scaffold.mjs";

const configWith = (overrides = {}) =>
  validateConfig({
    version: "1.0",
    environments: {
      st: { alias: "STSandbox", type: "sandbox", is_test_target: true },
    },
    pipeline_settings: overrides,
  }).config;

test("npm run is resolved to a script name, other commands are left alone", () => {
  assert.equal(parseNpmRun("npm run pipeline:lint"), "pipeline:lint");
  assert.equal(parseNpmRun("  yarn lint "), "lint");
  assert.equal(parseNpmRun("pnpm run prettier:verify"), "prettier:verify");
  assert.equal(parseNpmRun("npx eslint force-app"), null);
  assert.equal(
    parseNpmRun("npm test"),
    null,
    "npm test is not a resolvable script",
  );
  assert.equal(parseNpmRun(""), null);
});

test("a prettier gate that formats instead of checking is a failure", () => {
  // Exactly what `sf project generate --template standard` writes.
  const checks = auditGateCommands({
    config: configWith({
      prettier: { enabled: true, command: "npm run prettier" },
    }),
    packageJson: { scripts: { prettier: 'prettier --write "**/*.{cls,js}"' } },
  });

  const prettier = checks.find((check) => check.name === "prettier command");
  assert.equal(prettier.ok, false);
  assert.match(prettier.detail, /rewrites files/);
});

test("a --check command passes the audit", () => {
  const checks = auditGateCommands({
    config: configWith({
      prettier: { enabled: true, command: "npm run pipeline:prettier" },
    }),
    packageJson: {
      scripts: { "pipeline:prettier": PACKAGE_SCRIPTS["pipeline:prettier"] },
    },
  });
  assert.equal(
    checks.find((check) => check.name === "prettier command").ok,
    true,
  );
});

test("a missing script is named, not guessed at", () => {
  const checks = auditGateCommands({
    config: configWith({
      lint: { enabled: true, command: "npm run pipeline:lint" },
    }),
    packageJson: { scripts: {} },
  });
  const lint = checks[0];
  assert.equal(lint.ok, false);
  assert.match(lint.detail, /no "pipeline:lint" script/);
});

test("an eslint script that fails on an empty glob is flagged as a warning", () => {
  const checks = auditGateCommands({
    config: configWith({
      lint: { enabled: true, command: "npm run lint" },
      prettier: { enabled: false },
    }),
    packageJson: { scripts: { lint: "eslint **/{aura,lwc}/**/*.js" } },
  });
  const lint = checks[0];
  assert.equal(lint.ok, true, "it still works once LWC exists");
  assert.equal(lint.optional, true);
  assert.match(lint.detail, /exits 2 with no findings/);
});

test("the scripts this kit installs pass their own audit", () => {
  const checks = auditGateCommands({
    config: configWith({
      lint: { enabled: true },
      prettier: { enabled: true },
    }),
    packageJson: { scripts: PACKAGE_SCRIPTS },
  });
  assert.deepEqual(
    checks.map((check) => check.ok),
    [true, true],
    `defaults should audit clean: ${JSON.stringify(checks)}`,
  );
});

test("a direct command is not second-guessed", () => {
  const checks = auditGateCommands({
    config: configWith({
      lint: { enabled: true, command: "npx eslint force-app" },
      prettier: { enabled: false },
    }),
    packageJson: { scripts: {} },
  });
  assert.deepEqual(checks, []);
});

test("a disabled stage is not audited", () => {
  const checks = auditGateCommands({
    config: configWith({
      lint: { enabled: false },
      prettier: { enabled: false, command: "npm run prettier" },
    }),
    packageJson: { scripts: { prettier: "prettier --write ." } },
  });
  assert.deepEqual(checks, []);
});
