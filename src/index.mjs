/**
 * Public API of sfdx-devops-kit, for projects that want to script the pipeline
 * rather than shell out to the CLI.
 *
 *   import { loadConfig, planPipeline, runPipeline } from "sfdx-devops-kit";
 */

export {
  ANALYZER_ENGINES,
  authSecretName,
  CONFIG_FILENAME,
  deploySelector,
  E2E_TOOLS,
  ENV_TYPES,
  findConfigFile,
  INTEGRATION_TOOLS,
  loadConfig,
  resolveEnvironment,
  STAGE_ORDER,
  SUPPORTED_VERSIONS,
  TEST_LEVELS,
  validateConfig,
} from "./config.mjs";

export {
  analyzerCommand,
  deployCommand,
  enabledStages,
  planPipeline,
} from "./stages.mjs";

export { runPipeline, runStage } from "./run.mjs";

export {
  checkCoverage,
  cliErrorMessage,
  extractCoverage,
  parseAnalyzerResult,
  parseDeployResult,
  SEVERITY_LABELS,
} from "./results.mjs";

export {
  classifyPath,
  currentBranch,
  DEFAULT_API_VERSION,
  deriveDeliverables,
  parseNameStatus,
  readDiff,
  renderMarkdown,
  renderPackageXml,
} from "./deliverables.mjs";

export { extractTicketKey, statusFor, ticketContext } from "./backlog.mjs";

export {
  detectRtkSf,
  gateRtkSf,
  hasIndex,
  RTK_INSTALL_HINT,
  RTK_MCP_HINT,
  RTK_REPO,
  rtkAdvice,
} from "./rtk.mjs";

export {
  mergePackageJson,
  PACKAGE_DEV_DEPENDENCIES,
  PACKAGE_SCRIPTS,
  scaffold,
  SCAFFOLD_DIRS,
  TEMPLATE_MAP,
  TEMPLATE_ROOT,
} from "./scaffold.mjs";

export {
  BACKLOG_ENV_PATH,
  backlogEnvContents,
  ENV_KEY_PATTERN,
  nextSteps,
  normalizeBacklogDomain,
  planCredentials,
  renderEnvironmentsBlock,
  setScalar,
  setTopLevelScalar,
  SUGGESTED_KEYS,
  suggestEnvironment,
  upsertEnvironments,
  validateBacklogKey,
} from "./setup.mjs";

export { runSetup } from "./setup-wizard.mjs";

export { auditGateCommands, parseNpmRun } from "./npm-scripts.mjs";
