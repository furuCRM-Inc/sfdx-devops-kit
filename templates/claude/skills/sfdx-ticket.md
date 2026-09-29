---
name: sfdx-ticket
description: Create a Backlog ticket for Salesforce work, or read an assigned ticket and turn it into an implementation plan. Use when asked to create/register an issue, file a ticket, start work on a ticket key, read what a ticket requires, or plan an implementation from a Backlog issue.
---

# /sfdx-ticket — create and read Backlog tickets

Works through the **Backlog MCP server** registered in `.mcp.json` (default name
`backlog`, from nulab/backlog-mcp-server). Tool names below are that server's
actual names; if the project sets `backlog_integration.mcp.tool_prefix`, add the
prefix. The kit holds no Backlog credentials — the MCP server does.

Read `sfdx-pipeline.config.yml` for `backlog_integration.project_key`, the status
mapping and `status_ids`.

## A. Create a ticket

`add_issue` requires **numeric ids**, not names, so resolve them first:

1. `get_project({ projectKey: "<project_key>" })` → `id` for `projectId`
2. `get_issue_types({ projectKey: "<project_key>" })` → pick the type the work is
   (e.g. 課題 / タスク / バグ) → `issueTypeId`
3. `get_priorities()` → pick a priority → `priorityId`
4. `add_issue({ projectId, summary, issueTypeId, priorityId, description })`

Write the description so an agent can implement from it without asking:

```text
背景 / Context:
  なぜ必要か。今どう困っているか。

受入条件 / Acceptance criteria:
  - 検証できる条件を箇条書きで
  - 境界値も明記（例: 30% ちょうどは即時反映）

影響範囲（想定） / Expected scope:
  Opportunity（項目追加）、Apex コントローラ、LWC、承認プロセス

対象外 / Out of scope:
  含めないものを明記
```

Report the created key (e.g. `PROJ-142`) and the branch name to use:
`feature/PROJ-142-<short-summary>`.

## B. Read a ticket and plan the work

1. `get_issue({ issueKey: "PROJ-142" })` — summary, description, status, assignee.
2. `get_issue_comments({ issueKey: "PROJ-142" })` when the description looks
   incomplete; requirements often live in the comments.
3. Survey the existing implementation with rtk-sf rather than reading whole files:
   `search_codebase`, `query_compressed_spec`, `get_relations`,
   `get_object_schema`, `get_record_types`.
4. Produce a plan that names the components to change and the tests to add, and
   state the acceptance criteria you will verify.

Then confirm the branch:

```bash
npx sfdx-devops-kit ticket      # branch → key, and the status mapping
```

If the branch does not contain the key, say so and stop before implementing — the
review and deliverables steps both resolve the ticket from the branch name.

## C. Move the ticket to "in progress"

```text
update_issue({ issueKey: "PROJ-142", statusId: <id for status_mapping.in_progress> })
```

Get the id from `npx sfdx-devops-kit backlog --phase in_progress`. **Never guess
a status id.** This server exposes no status-listing tool, so ids come from
`backlog_integration.status_ids` or Backlog's built-ins (1 未対応 / 2 処理中 /
3 処理済み / 4 完了). If the id is unknown, say the status was left unchanged and
ask the team to add it to the config.

## Guardrails

- Never put an org auth URL, API key or session id into a ticket or comment.
- Do not close a ticket here; `closed` is a release decision.
- One ticket, one concern. If a request contains two independent changes, create
  two tickets and say why.
- Quote the ticket's own wording when planning; do not silently reinterpret an
  acceptance criterion.
