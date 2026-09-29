/**
 * Backlog integration.
 *
 * The kit holds no Backlog credentials: it resolves the ticket key, the comment
 * body and the status id, and the Claude Code skills issue the calls through
 * nulab/backlog-mcp-server. These tests pin the part that must be exact — the
 * tool names and the status id — because a wrong id silently moves a ticket to
 * an unrelated state.
 *
 * Tool names and parameters were taken from `tools/list` on
 * backlog-mcp-server v0.20.4, not from documentation.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  backlogTools,
  resolveStatus,
  STANDARD_BACKLOG_STATUS_IDS,
  validateConfig,
} from "../src/config.mjs";
import { TEMPLATE_ROOT } from "../src/scaffold.mjs";

function configure(backlog = {}) {
  const { config, errors, warnings } = validateConfig({
    version: "1.0",
    project_name: "demo",
    environments: { st: { alias: "A", type: "sandbox", is_test_target: true } },
    backlog_integration: { project_key: "PROJ", ...backlog },
  });
  return { config, errors, warnings };
}

test("built-in Backlog statuses resolve without configuration", () => {
  const { config, errors, warnings } = configure();
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);

  assert.deepEqual(resolveStatus(config, "in_progress"), {
    name: "処理中",
    id: 2,
    source: "standard",
  });
  assert.deepEqual(resolveStatus(config, "review_ready"), {
    name: "処理済み",
    id: 3,
    source: "standard",
  });
  assert.deepEqual(resolveStatus(config, "closed"), { name: "完了", id: 4, source: "standard" });
});

test("the standard id table matches Backlog's fixed ids", () => {
  assert.equal(STANDARD_BACKLOG_STATUS_IDS["未対応"], 1);
  assert.equal(STANDARD_BACKLOG_STATUS_IDS["処理中"], 2);
  assert.equal(STANDARD_BACKLOG_STATUS_IDS["処理済み"], 3);
  assert.equal(STANDARD_BACKLOG_STATUS_IDS["完了"], 4);
  assert.equal(STANDARD_BACKLOG_STATUS_IDS.Closed, 4, "English spaces resolve too");
});

test("a custom status is unresolved rather than guessed, and warns", () => {
  const { config, errors, warnings } = configure({
    status_mapping: { in_progress: "着手", review_ready: "レビュー待ち", closed: "完了" },
  });
  assert.deepEqual(errors, []);
  assert.equal(
    warnings.filter((warning) => warning.includes("status_ids")).length,
    2,
    "both unmapped custom statuses should warn",
  );

  const status = resolveStatus(config, "review_ready");
  assert.equal(status.id, null, "an unknown status must not be given an id");
  assert.equal(status.source, "unresolved");
});

test("an explicit status id wins over the built-in table", () => {
  const { config } = configure({
    status_mapping: { in_progress: "処理中", review_ready: "レビュー待ち", closed: "完了" },
    status_ids: { レビュー待ち: 5, 処理中: 99 },
  });
  assert.deepEqual(resolveStatus(config, "review_ready"), {
    name: "レビュー待ち",
    id: 5,
    source: "config",
  });
  assert.equal(resolveStatus(config, "in_progress").id, 99, "a project may renumber a status");
});

test("a non-numeric status id is rejected", () => {
  const { errors } = configure({ status_ids: { "処理済み": "three" } });
  assert.ok(errors.some((error) => error.includes("status_ids")));
});

test("an unmapped phase throws instead of returning something plausible", () => {
  const { config } = configure();
  assert.throws(() => resolveStatus(config, "released"), /No Backlog status mapped/);
});

test("tool names match backlog-mcp-server v0.20.4", () => {
  const { config } = configure();
  const tools = backlogTools(config);
  assert.equal(tools.server, "backlog");
  assert.equal(tools.getIssue, "get_issue");
  assert.equal(tools.getIssues, "get_issues");
  assert.equal(tools.addIssue, "add_issue");
  assert.equal(tools.updateIssue, "update_issue");
  assert.equal(tools.addComment, "add_issue_comment");
  assert.equal(tools.getComments, "get_issue_comments");
  assert.equal(tools.getProject, "get_project");
  assert.equal(tools.getIssueTypes, "get_issue_types");
  assert.equal(tools.getPriorities, "get_priorities");
});

test("--prefix on the server is honoured by the tool names", () => {
  const { config } = configure({ mcp: { server_name: "bl", runtime: "npx", tool_prefix: "bl_" } });
  const tools = backlogTools(config);
  assert.equal(tools.server, "bl");
  assert.equal(tools.getIssue, "bl_get_issue");
  assert.equal(tools.updateIssue, "bl_update_issue");
});

test("an unknown MCP runtime is rejected", () => {
  const { errors } = configure({ mcp: { server_name: "backlog", runtime: "podman" } });
  assert.ok(errors.some((error) => error.includes("mcp.runtime")));
});

test("the shipped .mcp.json registers Backlog and rtk-sf without credentials", () => {
  const body = fs.readFileSync(path.join(TEMPLATE_ROOT, "mcp/.mcp.json"), "utf8");
  const parsed = JSON.parse(body);

  assert.ok(parsed.mcpServers.backlog, "the Backlog server must be registered");
  assert.ok(parsed.mcpServers["rtk-sf"], "rtk-sf is integrated by default");
  assert.match(JSON.stringify(parsed.mcpServers.backlog), /ghcr\.io\/nulab\/backlog-mcp-server/);

  // Credentials are passed through from the environment, never written here.
  assert.equal(parsed.mcpServers.backlog.env.BACKLOG_API_KEY, "${BACKLOG_API_KEY}");
  assert.equal(parsed.mcpServers.backlog.env.BACKLOG_DOMAIN, "${BACKLOG_DOMAIN}");
  assert.ok(
    !/[A-Za-z0-9]{32,}/.test(body.replace(/backlog-mcp-server/g, "")),
    "no literal token-looking string may appear in the template",
  );
});

test("the ticket skill documents the id sequence add_issue actually requires", () => {
  const body = fs.readFileSync(path.join(TEMPLATE_ROOT, "claude/skills/sfdx-ticket.md"), "utf8");
  // add_issue requires projectId, summary, issueTypeId, priorityId — all numeric,
  // so the skill must resolve them before creating an issue.
  for (const tool of ["get_project", "get_issue_types", "get_priorities", "add_issue"]) {
    assert.ok(body.includes(tool), `the skill should name ${tool}`);
  }
  // The phrase wraps across lines in the document, so match tolerantly.
  assert.match(body, /Never guess\s+a status id/i);
});
