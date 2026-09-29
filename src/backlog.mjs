/**
 * backlog.mjs — resolve Backlog ticket context from the local repository.
 *
 * This module deliberately performs no network I/O. Posting comments and moving
 * statuses is done by the Backlog MCP server through the Claude Code skill, so
 * the kit never needs Backlog credentials and cannot leak them. What lives here
 * is the deterministic part: which ticket a branch refers to, and which status
 * name a pipeline phase maps to.
 */

import { currentBranch } from "./deliverables.mjs";

/**
 * Extract a ticket key from a branch name.
 *
 * Accepts the shapes teams actually use — `feature/SFDC_PROJ-123-add-field`,
 * `SFDC_PROJ-123`, `bugfix/sfdc_proj-123` — and, when `project_key` is set,
 * refuses keys belonging to another project so a stray match cannot move the
 * wrong ticket.
 *
 * @returns {{key: string|null, reason: string|null}}
 */
export function extractTicketKey(branch, { project_key: projectKey, branch_pattern: pattern } = {}) {
  if (!branch) return { key: null, reason: "no branch name available" };

  let regex;
  try {
    regex = new RegExp(pattern || "([A-Z][A-Z0-9_]*-\\d+)", "i");
  } catch (error) {
    return { key: null, reason: `invalid branch_pattern: ${error.message}` };
  }

  const match = regex.exec(branch);
  if (!match) {
    return {
      key: null,
      reason: `branch "${branch}" does not contain a ticket key matching ${regex.source}`,
    };
  }

  // Backlog keys are upper-case; normalize so `sfdc_proj-12` resolves too.
  const key = (match[1] ?? match[0]).toUpperCase();

  if (projectKey) {
    const expected = String(projectKey).toUpperCase();
    if (!key.startsWith(`${expected}-`)) {
      return {
        key: null,
        reason:
          `branch "${branch}" refers to ${key}, which is outside project ${expected} ` +
          `(backlog_integration.project_key)`,
      };
    }
  }

  return { key, reason: null };
}

/**
 * Full ticket context for the current checkout.
 *
 * @param {object} config validated config
 * @param {{cwd?: string, branch?: string}} options
 */
export function ticketContext(config, { cwd = process.cwd(), branch } = {}) {
  const backlog = config.backlog_integration ?? {};
  const branchName = branch ?? currentBranch(cwd);
  const { key, reason } = extractTicketKey(branchName, backlog);

  return {
    branch: branchName,
    project_key: backlog.project_key ?? "",
    ticket: key,
    unresolved_reason: reason,
    status_mapping: backlog.status_mapping ?? {},
  };
}

/**
 * Status name for a pipeline phase, e.g. "review_ready" → "処理済み".
 *
 * @throws {Error} when the phase is not mapped, so a typo cannot silently
 *                 leave a ticket in the wrong state.
 */
export function statusFor(config, phase) {
  const mapping = config.backlog_integration?.status_mapping ?? {};
  const status = mapping[phase];
  if (!status) {
    const known = Object.keys(mapping).join(", ") || "none";
    throw new Error(
      `No Backlog status mapped for phase "${phase}". Mapped phases: ${known} ` +
        `(backlog_integration.status_mapping).`,
    );
  }
  return status;
}
