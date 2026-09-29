/**
 * results.mjs — parse Salesforce CLI and analyzer output into gate decisions.
 *
 * Two shapes matter and both are handled explicitly:
 *
 *   success  { status: 0, result: { … } }
 *   failure  { status: 2, name, message }      ← no nested `result`
 *
 * The failure shape is the one that bites: `status` is the process exit code,
 * so code that assumes `result` exists crashes and hides the CLI's own message
 * (an "'int' object has no attribute 'title'"-class bug). Every parser here
 * checks for it first and surfaces the real message.
 */

/** Severity labels used by both analyzer engines (1 = most severe). */
export const SEVERITY_LABELS = {
  1: "Critical",
  2: "High",
  3: "Moderate",
  4: "Low",
  5: "Info",
};

/**
 * Detect the "CLI rejected the command" shape.
 *
 * @returns {string|null} the CLI's message, or null when this is a real result
 */
export function cliErrorMessage(payload) {
  if (!payload || typeof payload !== "object") return null;
  const hasResult = payload.result && typeof payload.result === "object" &&
    Object.keys(payload.result).length > 0;
  if (hasResult) return null;
  const status = payload.status;
  if (status === 0 || status === undefined || status === null) return null;
  const message = payload.message || payload.name || "Unknown Salesforce CLI error";
  return String(message).replace(/\s+/g, " ").trim();
}

/**
 * Summarize `sf project deploy start --json`.
 *
 * @returns {{ok: boolean, message: string, componentsDeployed: number,
 *            componentErrors: number, failures: object[], coverage: number|null,
 *            testsRan: number, testFailures: object[]}}
 */
export function parseDeployResult(payload) {
  const cliError = cliErrorMessage(payload);
  if (cliError) {
    return {
      ok: false,
      message: `Salesforce CLI error: ${cliError}`,
      componentsDeployed: 0,
      componentErrors: 0,
      failures: [],
      coverage: null,
      testsRan: 0,
      testFailures: [],
    };
  }

  const result = payload?.result ?? {};
  const details = result.details ?? {};
  const componentFailures = toArray(details.componentFailures);
  const runTest = details.runTestResult ?? {};
  const testFailures = toArray(runTest.failures).map((failure) => ({
    name: `${failure.name ?? "?"}.${failure.methodName ?? "?"}`,
    message: failure.message ?? "",
  }));

  const coverageWarnings = toArray(runTest.codeCoverageWarnings)
    .map((warning) => String(warning?.message ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const componentErrors = Number(result.numberComponentErrors ?? componentFailures.length ?? 0);
  const ok = result.success === true || (componentErrors === 0 && testFailures.length === 0 &&
    ["Succeeded", "SucceededPartial"].includes(String(result.status ?? "")));

  return {
    ok,
    message: ok
      ? `${result.status ?? "Succeeded"}: ${result.numberComponentsDeployed ?? 0} component(s)`
      : describeDeployFailure(result, componentFailures, testFailures, coverageWarnings),
    componentsDeployed: Number(result.numberComponentsDeployed ?? 0),
    componentErrors,
    failures: componentFailures.slice(0, 10).map((failure) => ({
      type: failure.componentType ?? "?",
      name: failure.fullName ?? "?",
      problem: failure.problem ?? "",
    })),
    coverage: extractCoverage(result),
    coverageWarnings,
    testsRan: Number(runTest.numTestsRun ?? result.numberTestsCompleted ?? 0),
    testFailures,
  };
}

function describeDeployFailure(result, componentFailures, testFailures, coverageWarnings = []) {
  if (componentFailures.length > 0) {
    const first = componentFailures[0];
    return `Deploy failed — ${componentFailures.length} component error(s), e.g. ` +
      `${first.componentType ?? "?"} ${first.fullName ?? "?"}: ${first.problem ?? ""}`;
  }
  if (testFailures.length > 0) {
    return `Deploy failed — ${testFailures.length} test failure(s), e.g. ` +
      `${testFailures[0].name}: ${testFailures[0].message}`;
  }
  // A deployment whose tests all pass can still fail Salesforce's own coverage
  // requirement. Without this the caller sees a bare "Failed" and has to open the
  // org to find out why. Org messages may be localized, so the platform's own
  // text is passed through rather than matched on.
  if (coverageWarnings.length > 0) {
    return `Deploy failed — org coverage requirement not met: ${coverageWarnings[0]}`;
  }
  return `Deploy ${result.status ?? "failed"} (no component or test failure reported)`;
}

/**
 * Org-wide coverage percentage from a deploy result, or null when absent.
 *
 * The CLI reports coverage in several shapes across versions; the warning
 * string ("Average test coverage across all Apex Classes and Triggers is 82%")
 * is the only one present for some validation deploys.
 */
export function extractCoverage(result) {
  const summary = result?.details?.runTestResult?.codeCoverageWarnings;
  const direct = result?.coverage?.coverage ?? result?.details?.runTestResult?.totalCoverage;
  if (typeof direct === "number") return direct;

  const numeric = Number(result?.details?.runTestResult?.codeCoveragePercentage);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;

  // Line counts are language-independent, so they come before parsing a warning
  // string: a localized org reports its coverage message in its own language.
  const classes = toArray(result?.details?.runTestResult?.codeCoverage);
  if (classes.length > 0) {
    let covered = 0;
    let total = 0;
    for (const entry of classes) {
      const lines = Number(entry.numLocations ?? 0);
      const uncovered = Number(entry.numLocationsNotCovered ?? 0);
      total += lines;
      covered += lines - uncovered;
    }
    if (total > 0) return Math.round((covered / total) * 1000) / 10;
  }

  // Fall back to the warning text, preferring an org-wide figure over a
  // per-class one when several warnings are present.
  const messages = toArray(summary).map((warning) => String(warning?.message ?? ""));
  const aggregate = messages.find((message) =>
    /average|all apex|overall|org-wide|全体|すべて|選択された/i.test(message),
  );
  for (const message of [aggregate, ...messages].filter(Boolean)) {
    const match = /(\d+(?:\.\d+)?)\s*%/.exec(message);
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * Evaluate the coverage gate.
 *
 * A null coverage value is not a pass: it means the deploy ran no tests, which
 * is reported as its own failure rather than being silently treated as 0 or 100.
 */
export function checkCoverage(coverage, threshold) {
  if (coverage === null || coverage === undefined) {
    return {
      ok: false,
      message:
        `Coverage gate cannot be evaluated: the deploy result reported no coverage. ` +
        `Check that test_level runs Apex tests (currently the deploy may be NoTestRun).`,
    };
  }
  const ok = coverage >= threshold;
  return {
    ok,
    message: ok
      ? `Coverage ${coverage}% meets the ${threshold}% threshold`
      : `Coverage ${coverage}% is below the ${threshold}% threshold`,
  };
}

/**
 * Rules that report a broken analyzer rather than a problem in the code.
 *
 * Code Analyzer v5 emits these as ordinary severity-1 "violations", so counting
 * them as findings tells the developer their code has three critical problems
 * when in fact no code was analyzed at all — the Java-based engines could not
 * start. They are separated out and reported as an infrastructure failure.
 */
const _ENGINE_ERROR_RULES = /Uninstantiable|EngineError|UnexpectedEngineError/i;

/**
 * Summarize analyzer output from either engine.
 *
 * Code Analyzer v5 writes `{ violations: [{ rule, severity, engine, locations }] }`;
 * the legacy scanner writes `[{ engine, fileName, violations: [{ severity, … }] }]`.
 */
export function parseAnalyzerResult(payload, threshold) {
  const cliError = cliErrorMessage(payload);
  if (cliError) {
    return { ok: false, message: `Analyzer error: ${cliError}`, violations: [], counts: {}, engineErrors: [] };
  }

  const all = normalizeViolations(payload);
  const engineErrors = all.filter((violation) => _ENGINE_ERROR_RULES.test(violation.rule));
  const violations = all.filter((violation) => !_ENGINE_ERROR_RULES.test(violation.rule));

  if (engineErrors.length > 0) {
    const engines = [...new Set(engineErrors.map((error) => error.engine))].join(", ");
    const reason = engineErrors[0].message.split("Attempt")[0].trim();
    return {
      ok: false,
      message:
        `Code Analyzer could not start ${engineErrors.length} engine(s) (${engines}), so the code ` +
        `was not analyzed: ${reason}`,
      violations,
      counts: {},
      engineErrors,
    };
  }

  const counts = {};
  for (const violation of violations) {
    counts[violation.severity] = (counts[violation.severity] ?? 0) + 1;
  }
  const blocking = violations.filter((violation) => violation.severity <= threshold);
  const ok = blocking.length === 0;

  return {
    ok,
    message: ok
      ? `No violations at severity <= ${threshold} (${violations.length} total finding(s))`
      : `${blocking.length} violation(s) at severity <= ${threshold} (${violations.length} total)`,
    violations: blocking.slice(0, 20),
    counts,
    engineErrors,
  };
}

function normalizeViolations(payload) {
  const out = [];

  // The two engines' report shapes must be distinguished, not both applied: a
  // v5 object is also a one-element array to `toArray`, which would count every
  // violation twice.
  const isLegacyReport = Array.isArray(payload);

  // Code Analyzer v5: { violations: [...] }
  if (!isLegacyReport) {
    for (const violation of toArray(payload?.violations)) {
      const location = toArray(violation.locations)[violation.primaryLocationIndex ?? 0] ??
        toArray(violation.locations)[0] ?? {};
      out.push({
        rule: violation.rule ?? "?",
        engine: violation.engine ?? "?",
        severity: Number(violation.severity ?? 5),
        file: location.file ?? "",
        line: location.startLine ?? null,
        message: (violation.message ?? "").replace(/\s+/g, " ").trim(),
      });
    }
    return out;
  }

  // Legacy sfdx-scanner: [{ engine, fileName, violations: [...] }]
  for (const group of payload) {
    for (const violation of toArray(group?.violations)) {
      out.push({
        rule: violation.ruleName ?? "?",
        engine: group.engine ?? "?",
        severity: Number(violation.severity ?? violation.normalizedSeverity ?? 5),
        file: group.fileName ?? "",
        line: violation.line ?? null,
        message: (violation.message ?? "").replace(/\s+/g, " ").trim(),
      });
    }
  }

  return out;
}

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}
