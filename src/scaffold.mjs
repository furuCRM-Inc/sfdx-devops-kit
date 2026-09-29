/**
 * scaffold.mjs — install the kit's templates into a target SFDX project.
 *
 * Non-destructive by default: an existing file is reported and left alone
 * unless `--force` is passed. `package.json` is never overwritten — its
 * `scripts` and `devDependencies` are merged, because clobbering a real
 * project's manifest would destroy dependency work that has nothing to do
 * with this pipeline.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_ROOT = path.resolve(here, "..", "templates");

/** Template file → destination path inside the target project. */
export const TEMPLATE_MAP = [
  ["config/sfdx-pipeline.config.yml", "sfdx-pipeline.config.yml"],
  ["github/workflows/sfdx-ci-cd.yml", ".github/workflows/sfdx-ci-cd.yml"],
  ["github/pull_request_template.md", ".github/pull_request_template.md"],
  ["mcp/.mcp.json", ".mcp.json"],
  ["claude/skills/sfdx-ticket.md", ".claude/skills/sfdx-ticket.md"],
  ["claude/skills/sfdx-review.md", ".claude/skills/sfdx-review.md"],
  ["claude/skills/sfdx-deliverables.md", ".claude/skills/sfdx-deliverables.md"],
  ["claude/rules/salesforce-governance.md", ".claude/rules/salesforce-governance.md"],
  ["knowledge/sfdx/coding-rules.md", "knowledge/sfdx/coding-rules.md"],
  ["knowledge/sfdx/review-checklist.md", "knowledge/sfdx/review-checklist.md"],
  ["tests/e2e/example.spec.js", "tests/e2e/example.spec.js"],
  ["playwright.config.js", "playwright.config.js"],
  [".forceignore", ".forceignore"],
];

/** Directories created even when empty, so the layout is obvious. */
export const SCAFFOLD_DIRS = [
  ".github/workflows",
  ".claude/skills",
  ".claude/rules",
  "knowledge/sfdx",
  "tests/e2e",
  "tests/integration",
  "scripts/pipeline",
  "manifest",
];

/** Scripts merged into the target `package.json`. */
export const PACKAGE_SCRIPTS = {
  // Matches the Salesforce template's own glob, plus the flag that keeps an
  // empty project (no LWC yet) from failing with exit 2.
  lint: 'eslint "**/{aura,lwc}/**/*.js" --no-error-on-unmatched-pattern',
  prettier: 'prettier --check "**/*.{cls,cmp,component,css,html,js,json,md,page,trigger,xml,yaml,yml}"',
  "prettier:format": 'prettier --write "**/*.{cls,cmp,component,css,html,js,json,md,page,trigger,xml,yaml,yml}"',
  "test:unit": "sfdx-lwc-jest",
  "test:e2e": "playwright test",
  "pipeline:validate": "sfdx-devops-kit validate",
  "pipeline:plan": "sfdx-devops-kit plan",
  "pipeline:deliverables": "sfdx-devops-kit deliverables",
};

/**
 * Dev dependencies merged into the target `package.json`.
 *
 * Only added when absent: a project generated from the Salesforce standard
 * template already pins these, and its pins win.
 *
 * `eslint` is pinned to 9.x deliberately, not to the newest release:
 * `@salesforce/eslint-config-lwc` declares `eslint: ^9` as a peer dependency, so
 * installing 10.x produces a project whose lint configuration cannot load.
 */
export const PACKAGE_DEV_DEPENDENCIES = {
  "@playwright/test": "^1.63.0",
  "@prettier/plugin-xml": "^3.4.2",
  "@salesforce/eslint-config-lwc": "^4.1.2",
  "@salesforce/sfdx-lwc-jest": "^7.9.0",
  eslint: "^9.39.5",
  prettier: "^3.9.9",
  "prettier-plugin-apex": "^2.3.0",
};

/**
 * Install templates into `targetDir`.
 *
 * @param {{targetDir: string, force?: boolean, dryRun?: boolean,
 *          projectName?: string, versions?: object}} options
 * @returns {{created: string[], skipped: string[], overwritten: string[],
 *            packageJson: string, dirs: string[]}}
 */
export function scaffold({
  targetDir,
  force = false,
  dryRun = false,
  projectName,
  versions = PACKAGE_DEV_DEPENDENCIES,
} = {}) {
  const root = path.resolve(targetDir);
  const created = [];
  const skipped = [];
  const overwritten = [];
  const dirs = [];

  for (const relative of SCAFFOLD_DIRS) {
    const dir = path.join(root, relative);
    if (!fs.existsSync(dir)) {
      dirs.push(relative);
      if (!dryRun) fs.mkdirSync(dir, { recursive: true });
    }
  }

  for (const [templateRelative, destinationRelative] of TEMPLATE_MAP) {
    const source = path.join(TEMPLATE_ROOT, templateRelative);
    const destination = path.join(root, destinationRelative);
    if (!fs.existsSync(source)) {
      throw new Error(`Template missing from the kit: ${templateRelative}`);
    }

    const exists = fs.existsSync(destination);
    if (exists && !force) {
      skipped.push(destinationRelative);
      continue;
    }

    let body = fs.readFileSync(source, "utf8");
    if (projectName) body = body.replaceAll("__PROJECT_NAME__", projectName);

    if (!dryRun) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, body, "utf8");
    }
    (exists ? overwritten : created).push(destinationRelative);
  }

  const packageJson = mergePackageJson({ root, dryRun, projectName, versions });
  return { created, skipped, overwritten, dirs, packageJson };
}

/**
 * Merge pipeline scripts and dev dependencies into the target `package.json`.
 *
 * Existing entries win: a project that pins its own eslint keeps that pin, and
 * a script the team has customized is left untouched. What is missing is added.
 *
 * @returns {"created"|"merged"|"unchanged"}
 */
export function mergePackageJson({ root, dryRun = false, projectName, versions = PACKAGE_DEV_DEPENDENCIES }) {
  const file = path.join(root, "package.json");

  if (!fs.existsSync(file)) {
    const manifest = {
      name: projectName || path.basename(root),
      version: "1.0.0",
      private: true,
      scripts: { ...PACKAGE_SCRIPTS },
      devDependencies: sortKeys({ ...versions }),
    };
    if (!dryRun) fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return "created";
  }

  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  let changed = false;

  manifest.scripts ??= {};
  for (const [name, command] of Object.entries(PACKAGE_SCRIPTS)) {
    if (!(name in manifest.scripts)) {
      manifest.scripts[name] = command;
      changed = true;
    }
  }

  manifest.devDependencies ??= {};
  for (const [name, range] of Object.entries(versions)) {
    const alreadyPresent = name in manifest.devDependencies ||
      name in (manifest.dependencies ?? {});
    if (!alreadyPresent) {
      manifest.devDependencies[name] = range;
      changed = true;
    }
  }
  manifest.devDependencies = sortKeys(manifest.devDependencies);

  if (changed && !dryRun) {
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  return changed ? "merged" : "unchanged";
}

function sortKeys(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
}

/** Read a template's contents (used by `init --print`). */
export function readTemplate(relative) {
  return fs.readFileSync(path.join(TEMPLATE_ROOT, relative), "utf8");
}
