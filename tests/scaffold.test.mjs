/**
 * Scaffolding runs against real projects, so it must never destroy work: an
 * existing file is kept, and package.json is merged rather than overwritten.
 * The original design's script clobbered package.json outright, which would
 * delete a project's dependency set.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { load as parseYaml } from "js-yaml";

import {
  mergePackageJson,
  PACKAGE_DEV_DEPENDENCIES,
  PACKAGE_SCRIPTS,
  scaffold,
  TEMPLATE_MAP,
  TEMPLATE_ROOT,
} from "../src/scaffold.mjs";
import { validateConfig } from "../src/config.mjs";

function project(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-project-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "sfdx-project.json"),
    JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }] }, null, 2),
  );
  for (const [relative, body] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return root;
}

test("every mapped template exists in the kit", () => {
  for (const [source] of TEMPLATE_MAP) {
    assert.ok(
      fs.existsSync(path.join(TEMPLATE_ROOT, source)),
      `template ${source} is mapped but missing from the package`,
    );
  }
});

test("a fresh project receives the whole pipeline", (t) => {
  const root = project(t);
  const result = scaffold({ targetDir: root, projectName: "demo" });

  for (const [, destination] of TEMPLATE_MAP) {
    assert.ok(fs.existsSync(path.join(root, destination)), `${destination} should be created`);
  }
  assert.equal(result.skipped.length, 0);
  assert.equal(result.packageJson, "created");
  assert.ok(fs.existsSync(path.join(root, ".github/workflows/sfdx-ci-cd.yml")));
  assert.ok(fs.existsSync(path.join(root, ".claude/skills/sfdx-review.md")));
});

test("the project name is substituted into the generated config", (t) => {
  const root = project(t);
  scaffold({ targetDir: root, projectName: "acme-crm" });
  const body = fs.readFileSync(path.join(root, "sfdx-pipeline.config.yml"), "utf8");
  assert.ok(!body.includes("__PROJECT_NAME__"), "placeholder should be replaced");
  assert.match(body, /project_name: "acme-crm"/);
});

test("the generated config is valid input for this kit", (t) => {
  const root = project(t);
  scaffold({ targetDir: root, projectName: "demo" });
  const raw = parseYaml(fs.readFileSync(path.join(root, "sfdx-pipeline.config.yml"), "utf8"));
  const { errors, warnings } = validateConfig(raw);
  assert.deepEqual(errors, [], `shipped template must validate: ${errors.join("; ")}`);
  assert.deepEqual(warnings, [], `shipped template should not warn: ${warnings.join("; ")}`);
});

test("existing files are kept unless --force is given", (t) => {
  const root = project(t, {
    "sfdx-pipeline.config.yml": "version: '1.0'\n# hand-tuned, do not lose this\n",
  });

  const kept = scaffold({ targetDir: root, projectName: "demo" });
  assert.ok(kept.skipped.includes("sfdx-pipeline.config.yml"));
  assert.match(fs.readFileSync(path.join(root, "sfdx-pipeline.config.yml"), "utf8"), /hand-tuned/);

  const forced = scaffold({ targetDir: root, projectName: "demo", force: true });
  assert.ok(forced.overwritten.includes("sfdx-pipeline.config.yml"));
  assert.ok(!fs.readFileSync(path.join(root, "sfdx-pipeline.config.yml"), "utf8").includes("hand-tuned"));
});

test("a dry run writes nothing", (t) => {
  const root = project(t);
  const result = scaffold({ targetDir: root, projectName: "demo", dryRun: true });

  assert.ok(result.created.length > 0, "should still report what it would create");
  assert.equal(fs.existsSync(path.join(root, "sfdx-pipeline.config.yml")), false);
  assert.equal(fs.existsSync(path.join(root, "package.json")), false);
  assert.equal(fs.existsSync(path.join(root, ".github")), false);
});

test("package.json is merged, never overwritten", (t) => {
  const root = project(t, {
    "package.json": JSON.stringify(
      {
        name: "existing-project",
        version: "3.1.0",
        scripts: { lint: "my-custom-linter", build: "rollup -c" },
        devDependencies: { eslint: "^8.0.0", "some-tool": "^1.0.0" },
        dependencies: { lodash: "^4.17.21" },
      },
      null,
      2,
    ),
  });

  const status = mergePackageJson({ root });
  assert.equal(status, "merged");

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.name, "existing-project", "identity is preserved");
  assert.equal(manifest.version, "3.1.0");
  assert.equal(manifest.scripts.lint, "my-custom-linter", "a customized script is not replaced");
  assert.equal(manifest.scripts.build, "rollup -c", "unrelated scripts survive");
  assert.equal(manifest.scripts["test:e2e"], PACKAGE_SCRIPTS["test:e2e"], "missing scripts are added");
  assert.equal(manifest.devDependencies.eslint, "^8.0.0", "an existing pin is respected");
  assert.equal(manifest.devDependencies["some-tool"], "^1.0.0");
  assert.equal(manifest.devDependencies.prettier, PACKAGE_DEV_DEPENDENCIES.prettier);
  assert.deepEqual(manifest.dependencies, { lodash: "^4.17.21" }, "dependencies are untouched");
});

test("merging twice changes nothing the second time", (t) => {
  const root = project(t);
  assert.equal(mergePackageJson({ root }), "created");
  assert.equal(mergePackageJson({ root }), "unchanged");
});

test("a dependency already in dependencies is not duplicated into devDependencies", (t) => {
  const root = project(t, {
    "package.json": JSON.stringify({ name: "x", dependencies: { prettier: "^3.0.0" } }),
  });
  mergePackageJson({ root });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.devDependencies.prettier, undefined);
  assert.equal(manifest.dependencies.prettier, "^3.0.0");
});

test("the generated workflow is valid YAML with steps in every job", (t) => {
  const root = project(t);
  scaffold({ targetDir: root, projectName: "demo" });
  const workflow = parseYaml(
    fs.readFileSync(path.join(root, ".github/workflows/sfdx-ci-cd.yml"), "utf8"),
  );

  assert.ok(workflow.jobs, "workflow must declare jobs");
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.ok(Array.isArray(job.steps), `job ${name} must have a steps array`);
    assert.ok(job.steps.length > 0, `job ${name} must have at least one step`);
  }
  // The deploy job must never run for a pull request.
  assert.match(workflow.jobs.deploy.if, /github\.event_name != 'pull_request'/);
});

test("the workflow gates every optional step on the plan", (t) => {
  const root = project(t);
  scaffold({ targetDir: root, projectName: "demo" });
  const body = fs.readFileSync(path.join(root, ".github/workflows/sfdx-ci-cd.yml"), "utf8");

  for (const stage of ["lint", "prettier", "code_analyzer", "integration_test", "e2e_test", "documentation"]) {
    assert.ok(
      body.includes(`enabled.${stage}`),
      `step for ${stage} should be gated by the plan's enabled map`,
    );
  }
  // Secrets are referenced by the name the plan resolves, never hardcoded.
  assert.ok(body.includes("secrets[needs.plan.outputs.auth_secret]"));
  assert.ok(!/SF_[A-Z]+_AUTH_URL/.test(body), "no hardcoded secret names");
});

test("the Claude skills declare the frontmatter Claude Code needs", (t) => {
  const root = project(t);
  scaffold({ targetDir: root, projectName: "demo" });

  for (const skill of ["sfdx-review", "sfdx-deliverables"]) {
    const body = fs.readFileSync(path.join(root, `.claude/skills/${skill}.md`), "utf8");
    assert.match(body, /^---\n/, `${skill} must start with frontmatter`);
    assert.match(body, new RegExp(`name: ${skill}`));
    assert.match(body, /description: .{40,}/, `${skill} needs a description for triggering`);
  }
});
