/**
 * Gate decisions come from parsed CLI output. The failure shape matters most:
 * when the CLI rejects a command it returns `status` (the exit code) with no
 * nested `result`, and code that assumes `result` exists crashes and hides the
 * real message.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkCoverage,
  cliErrorMessage,
  extractCoverage,
  parseAnalyzerResult,
  parseDeployResult,
} from "../src/results.mjs";

test("the CLI error shape is detected and its message surfaced", () => {
  const payload = {
    status: 2,
    name: "Error",
    message:
      "The following errors occurred:\n  --metadata=ApexClass:Foo cannot also be provided when using --source-dir",
    exitCode: 2,
  };
  assert.match(cliErrorMessage(payload), /cannot also be provided/);

  const summary = parseDeployResult(payload);
  assert.equal(summary.ok, false);
  assert.match(summary.message, /Salesforce CLI error/);
  assert.match(summary.message, /cannot also be provided/);
  assert.equal(summary.coverage, null);
});

test("a successful result is not mistaken for an error", () => {
  const payload = { status: 0, result: { status: "Succeeded", success: true, numberComponentsDeployed: 12 } };
  assert.equal(cliErrorMessage(payload), null);
  const summary = parseDeployResult(payload);
  assert.equal(summary.ok, true);
  assert.equal(summary.componentsDeployed, 12);
  assert.match(summary.message, /12 component/);
});

test("component failures are summarized with the first problem", () => {
  const payload = {
    status: 1,
    result: {
      status: "Failed",
      success: false,
      numberComponentErrors: 2,
      details: {
        componentFailures: [
          { componentType: "ApexClass", fullName: "OrderService", problem: "Variable does not exist" },
          { componentType: "Flow", fullName: "Order_Followup", problem: "Invalid element" },
        ],
      },
    },
  };
  const summary = parseDeployResult(payload);
  assert.equal(summary.ok, false);
  assert.equal(summary.componentErrors, 2);
  assert.match(summary.message, /ApexClass OrderService: Variable does not exist/);
  assert.equal(summary.failures.length, 2);
});

test("test failures fail the deploy even when components deployed", () => {
  const payload = {
    status: 1,
    result: {
      status: "Failed",
      numberComponentsDeployed: 3,
      numberComponentErrors: 0,
      details: {
        runTestResult: {
          numTestsRun: 4,
          failures: [{ name: "OrderServiceTest", methodName: "testDiscount", message: "Assertion failed" }],
        },
      },
    },
  };
  const summary = parseDeployResult(payload);
  assert.equal(summary.ok, false);
  assert.match(summary.message, /OrderServiceTest\.testDiscount/);
  assert.equal(summary.testsRan, 4);
});

test("coverage is read from every shape the CLI reports", () => {
  assert.equal(extractCoverage({ coverage: { coverage: 82 } }), 82);
  assert.equal(
    extractCoverage({
      details: { runTestResult: { codeCoverageWarnings: [{ message: "Average test coverage across all Apex Classes and Triggers is 67%, at least 75% is required" }] } },
    }),
    67,
  );
  assert.equal(
    extractCoverage({
      details: {
        runTestResult: {
          codeCoverage: [
            { numLocations: 100, numLocationsNotCovered: 10 },
            { numLocations: 100, numLocationsNotCovered: 30 },
          ],
        },
      },
    }),
    80,
  );
  assert.equal(extractCoverage({ details: {} }), null);
});

test("an unmeasurable coverage figure fails the gate rather than passing quietly", () => {
  const missing = checkCoverage(null, 75);
  assert.equal(missing.ok, false);
  assert.match(missing.message, /reported no coverage/);

  assert.equal(checkCoverage(75, 75).ok, true, "meeting the threshold exactly passes");
  assert.equal(checkCoverage(74.9, 75).ok, false);
  assert.match(checkCoverage(60, 75).message, /60% is below the 75% threshold/);
});

test("Code Analyzer v5 violations gate on the severity threshold", () => {
  const payload = {
    violations: [
      {
        rule: "ApexCRUDViolation",
        engine: "pmd",
        severity: 2,
        message: "Validate CRUD permission",
        locations: [{ file: "force-app/OrderService.cls", startLine: 42 }],
        primaryLocationIndex: 0,
      },
      { rule: "UnusedLocalVariable", engine: "pmd", severity: 4, message: "Unused", locations: [] },
    ],
  };

  const blocking = parseAnalyzerResult(payload, 3);
  assert.equal(blocking.ok, false);
  assert.match(blocking.message, /1 violation\(s\) at severity <= 3 \(2 total\)/);
  assert.equal(blocking.violations[0].rule, "ApexCRUDViolation");
  assert.equal(blocking.violations[0].line, 42);

  const lenient = parseAnalyzerResult(payload, 1);
  assert.equal(lenient.ok, true);
  assert.match(lenient.message, /No violations at severity <= 1/);
});

test("the legacy scanner report shape is understood too", () => {
  const payload = [
    {
      engine: "pmd",
      fileName: "force-app/OrderService.cls",
      violations: [{ ruleName: "AvoidSoqlInLoops", severity: 1, line: 10, message: "SOQL in loop" }],
    },
  ];
  const summary = parseAnalyzerResult(payload, 3);
  assert.equal(summary.ok, false);
  assert.equal(summary.violations[0].rule, "AvoidSoqlInLoops");
  assert.equal(summary.violations[0].file, "force-app/OrderService.cls");
});

test("an analyzer error is reported as an error, not as zero violations", () => {
  const summary = parseAnalyzerResult({ status: 1, message: "Engine failed to start" }, 3);
  assert.equal(summary.ok, false);
  assert.match(summary.message, /Analyzer error: Engine failed to start/);
});

// ---------------------------------------------------------------------------
// Shapes observed on a real org, which the synthetic fixtures above did not
// produce. Both of these were bugs found only by running against a live
// sandbox: the failure reason went missing, and coverage parsing assumed the
// org spoke English.
// ---------------------------------------------------------------------------

test("a deploy that fails only the org coverage requirement says so", () => {
  // Every test passed (numFailures: 0, numTestsRun: 6) and no component
  // errored, yet result.status is Failed: Salesforce rejected it on coverage.
  const payload = {
    status: 1,
    result: {
      status: "Failed",
      success: false,
      numberComponentErrors: 0,
      numberComponentsDeployed: 1,
      numberTestsCompleted: 6,
      details: {
        componentFailures: [],
        runTestResult: {
          numFailures: 0,
          numTestsRun: 6,
          failures: [],
          codeCoverage: [],
          codeCoverageWarnings: [
            {
              message:
                "選択された Apex Class のテストカバー率は 0% です。少なくとも 75% 以上のテストカバー率が必要です。",
            },
          ],
        },
      },
    },
  };

  const summary = parseDeployResult(payload);
  assert.equal(summary.ok, false);
  assert.match(summary.message, /coverage requirement not met/);
  assert.match(summary.message, /75%/, "the org's own wording is passed through");
  assert.equal(summary.testsRan, 6);
  assert.equal(summary.coverageWarnings.length, 1);
});

test("a failure with no reported cause admits that instead of saying nothing", () => {
  const summary = parseDeployResult({
    status: 1,
    result: { status: "Failed", success: false, numberComponentErrors: 0, details: {} },
  });
  assert.match(summary.message, /no component or test failure reported/);
});

test("coverage comes from line counts before any localized warning is parsed", () => {
  // A Japanese org reports "…は 45% です。少なくとも 75%…". Parsing text first
  // would work here by luck, but not for every locale or message order, so the
  // line counts win when present.
  const result = {
    details: {
      runTestResult: {
        codeCoverage: [{ numLocations: 200, numLocationsNotCovered: 40 }],
        codeCoverageWarnings: [
          { message: "選択された Apex Class のテストカバー率は 45% です。少なくとも 75% 以上が必要です。" },
        ],
      },
    },
  };
  assert.equal(extractCoverage(result), 80, "160/200 covered lines");
});

test("a localized warning is still parsed when no line counts are present", () => {
  assert.equal(
    extractCoverage({
      details: {
        runTestResult: {
          codeCoverage: [],
          codeCoverageWarnings: [
            { message: "選択された Apex Class のテストカバー率は 0% です。少なくとも 75% 以上が必要です。" },
          ],
        },
      },
    }),
    0,
    "0% is a real measurement, not a missing one",
  );
});

test("an org-wide warning is preferred over a per-class one", () => {
  const coverage = extractCoverage({
    details: {
      runTestResult: {
        codeCoverage: [],
        codeCoverageWarnings: [
          { message: "Apex Class OrderService has 12% coverage" },
          { message: "Average test coverage across all Apex Classes and Triggers is 78%" },
        ],
      },
    },
  });
  assert.equal(coverage, 78);
});

test("engine start-up failures are reported as such, not as code violations", () => {
  // Observed on a machine without a JDK: Code Analyzer v5 emits these as
  // ordinary severity-1 violations, which would tell the developer their code
  // has three critical problems when no code was analyzed at all.
  const payload = {
    violations: [
      {
        rule: "UninstantiableEngineError",
        engine: "pmd",
        severity: 1,
        message:
          "The engine with name 'pmd' could not be instantiated. Error: Could not locate Java v11.0.0+.\n  | Attempt 1: ...",
        locations: [{ comment: "Undefined Code Location" }],
      },
      {
        rule: "UninstantiableEngineError",
        engine: "sfge",
        severity: 1,
        message: "The engine with name 'sfge' could not be instantiated. Error: Could not locate Java v11.0.0+.",
        locations: [{ comment: "Undefined Code Location" }],
      },
    ],
  };

  const summary = parseAnalyzerResult(payload, 3);
  assert.equal(summary.ok, false, "an analyzer that did not run must not pass the gate");
  assert.match(summary.message, /could not start 2 engine\(s\) \(pmd, sfge\)/);
  assert.match(summary.message, /was not analyzed/);
  assert.match(summary.message, /Could not locate Java/);
  assert.deepEqual(summary.violations, [], "engine errors are not code findings");
  assert.equal(summary.engineErrors.length, 2);
});

test("real violations are still counted when one engine fails", () => {
  const payload = {
    violations: [
      { rule: "UninstantiableEngineError", engine: "cpd", severity: 1, message: "no java", locations: [] },
      {
        rule: "ApexCRUDViolation",
        engine: "pmd",
        severity: 2,
        message: "Validate CRUD permission",
        locations: [{ file: "force-app/A.cls", startLine: 3 }],
      },
    ],
  };
  const summary = parseAnalyzerResult(payload, 3);
  assert.equal(summary.ok, false);
  assert.match(summary.message, /could not start 1 engine/);
  assert.equal(summary.violations.length, 1, "the genuine finding is preserved for the report");
  assert.equal(summary.violations[0].rule, "ApexCRUDViolation");
});
