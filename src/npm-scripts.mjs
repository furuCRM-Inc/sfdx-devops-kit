/**
 * npm-scripts.mjs — check that the gate commands do what the gate claims.
 *
 * A quality gate is only a gate if its command reports failure. Two ways that
 * quietly stops being true in a real project, both seen in a project generated
 * from the Salesforce standard template:
 *
 *   - `npm run prettier` is defined there as `prettier --write`. It formats the
 *     working tree and exits 0, so a "format check" stage always passes.
 *   - `npm run lint` is defined without `--no-error-on-unmatched-pattern`, so a
 *     project with no LWC yet exits 2 with no findings and fails the build for
 *     no reason.
 *
 * Both are configuration mistakes, not code problems, so they are reported by
 * `doctor` rather than discovered halfway through a release.
 */

/** The script name behind `npm run <name>`, or null for anything else. */
export function parseNpmRun(command) {
  const match = /^\s*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:@./-]+)/.exec(
    String(command || ""),
  );
  if (!match) return null;
  const name = match[1];
  // `npm test` and `npm install` are not user scripts we can resolve.
  return ["install", "ci", "test", "start"].includes(name) ? null : name;
}

/**
 * Audit the lint and prettier stage commands against the project's scripts.
 *
 * @param {{config: object, packageJson: object|null}} input
 * @returns {{name: string, ok: boolean, optional: boolean, detail: string}[]}
 */
export function auditGateCommands({ config, packageJson }) {
  const checks = [];
  const scripts = packageJson?.scripts ?? {};
  const stages = config?.pipeline_settings ?? {};

  for (const stage of ["lint", "prettier"]) {
    const settings = stages[stage];
    if (!settings?.enabled) continue;

    const command = settings.command;
    const script = parseNpmRun(command);
    if (!script) {
      // A direct command (or a task runner we do not know): nothing to resolve.
      continue;
    }
    if (!(script in scripts)) {
      checks.push({
        name: `${stage} command`,
        ok: false,
        optional: false,
        detail: `${command} — package.json has no "${script}" script (run \`sfdx-devops-kit init .\` or set pipeline_settings.${stage}.command)`,
      });
      continue;
    }

    const resolved = String(scripts[script]);
    if (
      stage === "prettier" &&
      /--write\b/.test(resolved) &&
      !/--check\b/.test(resolved)
    ) {
      checks.push({
        name: "prettier command",
        ok: false,
        optional: false,
        detail: `"${script}" runs \`--write\`: it rewrites files and always passes. Use \`npm run pipeline:prettier\` (or any \`--check\` command) as the gate.`,
      });
      continue;
    }
    if (
      stage === "lint" &&
      /\beslint\b/.test(resolved) &&
      !resolved.includes("--no-error-on-unmatched-pattern")
    ) {
      checks.push({
        name: "lint command",
        ok: true,
        optional: true,
        detail: `"${script}" has no --no-error-on-unmatched-pattern: ESLint exits 2 with no findings when a glob (aura/, lwc/) matches nothing`,
      });
      continue;
    }
    checks.push({
      name: `${stage} command`,
      ok: true,
      optional: false,
      detail: `${command} → ${resolved}`,
    });
  }

  return checks;
}
