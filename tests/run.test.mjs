/**
 * What a failing stage tells the reader.
 *
 * `exit 1` is not a reason. A gate that fails has to carry the tool's own words,
 * because in CI the log is all anyone has — and locally, re-running the command
 * by hand to find out why is exactly the work the pipeline was meant to save.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { runStage } from "../src/run.mjs";

const stage = (overrides = {}) => ({
  id: "lint",
  name: "Lint (ESLint)",
  enabled: true,
  fail_on_error: true,
  commands: [],
  ...overrides,
});

/** A command that prints the given lines and exits with `code`. */
const printing = (lines, code) =>
  `node -e ${JSON.stringify(`console.log(${JSON.stringify(lines.join("\n"))}); process.exit(${code})`)}`;

test("a failing lint stage reports ESLint's own summary, not the exit code", () => {
  const outcome = runStage(
    stage({
      commands: [
        printing(
          [
            "force-app/main/default/lwc/demoCard/demoCard.js",
            '  6:22  error  Invalid usage of "querySelector"  @lwc/lwc/no-document-query',
            "✖ 2 problems (2 errors, 0 warnings)",
          ],
          1,
        ),
      ],
    }),
    { cwd: process.cwd(), dryRun: false, state: {}, config: {} },
  );

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.message, "2 problems (2 errors, 0 warnings) (exit 1)");
  assert.ok(
    !outcome.message.startsWith("✖"),
    "the caller prints its own marker",
  );
  assert.match(
    outcome.output,
    /no-document-query/,
    "the findings are carried for display",
  );
});

test("a failing prettier stage names the format problem", () => {
  const outcome = runStage(
    stage({
      id: "prettier",
      name: "Format check (Prettier)",
      commands: [
        printing(
          [
            "Checking formatting...",
            "[warn] force-app/x.js",
            "[warn] Code style issues found in 9 files.",
          ],
          1,
        ),
      ],
    }),
    { cwd: process.cwd(), dryRun: false, state: {}, config: {} },
  );

  assert.equal(outcome.status, "failed");
  assert.match(outcome.message, /Code style issues found in 9 files/);
});

test("an empty glob is still a pass, not a failure", () => {
  const outcome = runStage(
    stage({
      commands: [
        printing(
          ['No files matching the pattern "**/aura/**/*.js" were found.'],
          2,
        ),
      ],
    }),
    { cwd: process.cwd(), dryRun: false, state: {}, config: {} },
  );

  assert.equal(outcome.status, "passed");
  assert.match(outcome.message, /glob matched nothing/);
});

test("a passing stage says so without dragging output along", () => {
  const outcome = runStage(stage({ commands: [printing(["all good"], 0)] }), {
    cwd: process.cwd(),
    dryRun: false,
    state: {},
    config: {},
  });

  assert.equal(outcome.status, "passed");
  assert.equal(outcome.message, "ok");
  assert.equal(outcome.output, undefined);
});

test("a missing command is explained, not reported as exit 127", () => {
  const outcome = runStage(
    stage({ commands: ["sfdx-devops-kit-not-a-real-binary"] }),
    {
      cwd: process.cwd(),
      dryRun: false,
      state: {},
      config: {},
    },
  );

  assert.equal(outcome.status, "failed");
  assert.match(outcome.message, /command not found|not a real binary|exit/i);
});

test("a stage with no output at all still fails with the exit code", () => {
  const outcome = runStage(stage({ commands: ['node -e "process.exit(3)"'] }), {
    cwd: process.cwd(),
    dryRun: false,
    state: {},
    config: {},
  });

  assert.equal(outcome.status, "failed");
  assert.match(outcome.message, /exit 3/);
});
