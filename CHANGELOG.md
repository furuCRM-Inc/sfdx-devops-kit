# Changelog

All notable changes to sfdx-devops-kit are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-29

First release: a configuration-driven pipeline any Salesforce DX project can adopt.

### Added

**Configuration as the single source of truth**
- `sfdx-pipeline.config.yml` read by GitHub Actions, the CLI and the Claude Code
  skills alike. `plan --json` emits a flat `enabled` map so each workflow step is
  gated by one expression.
- Validation reports the YAML path of every problem and refuses combinations the
  Salesforce CLI would reject later — notably `--manifest`/`--source-dir`/
  `--metadata` together, and `RunSpecifiedTests` without a test list.

**Nine pipeline stages with real gates**
- `lint`, `prettier`, `code_analyzer`, `validate_deploy`, `unit_test`, `deploy`,
  `integration_test`, `e2e_test`, `documentation`.
- Salesforce Code Analyzer v5 (`sf code-analyzer run`) and the legacy
  `sf scanner run` are both supported.
- Apex tests run once: the coverage gate reads the validation deploy's result
  rather than deploying a second time.
- Failures report their real cause. A deploy whose tests all pass can still fail
  Salesforce's own coverage requirement, and the org's message — including
  localized ones — is surfaced instead of a bare "Failed". An analyzer that
  cannot start its engines is reported as an infrastructure problem, not as
  code findings.

**Per-ticket metadata deliverables**
- `deliverables` turns a git diff into the Salesforce components a ticket
  shipped, and emits a `package.xml` for exactly that change.
- Bundles collapse to one component, `-meta.xml` companions are not counted
  twice, and object children are reported as `Object.Field`. Only paths under a
  package directory from `sfdx-project.json` count as metadata, so a GitHub
  workflow is never mistaken for a Salesforce Workflow.

**Backlog integration (nulab/backlog-mcp-server)**
- `.mcp.json` registers the Backlog MCP server and rtk-sf; credentials stay in
  `BACKLOG_DOMAIN`/`BACKLOG_API_KEY` and never enter the repository.
- `backlog` prints the exact MCP calls for the current branch — `get_issue`,
  `add_issue_comment`, `update_issue` — with the resolved `statusId`.
- The server exposes no status-listing tool, so status names resolve through
  Backlog's built-in ids (1 未対応 / 2 処理中 / 3 処理済み / 4 完了) or an explicit
  `backlog_integration.status_ids` map. An unknown status is reported as
  unresolved rather than guessed.

**Claude Code skills**
- `/sfdx-ticket` creates a ticket (resolving the numeric ids `add_issue`
  requires) and turns an assigned ticket into an implementation plan.
- `/sfdx-review` reviews the diff against `knowledge/sfdx/coding-rules.md`, posts
  findings plus the delivered-metadata list to Backlog, and moves the ticket only
  when nothing critical is open.
- `/sfdx-deliverables` records what a ticket shipped.

**rtk-sf integrated by default**
- Compressed metadata specs over MCP and generated system documentation. Missing
  rtk-sf skips its stages with a hint instead of failing the build; set
  `ai_assist.rtk_sf.required: true` to make it mandatory.

**Scaffolding that cannot destroy work**
- `init` keeps existing files unless `--force`, supports `--dry-run`, and
  *merges* `package.json` so a project's own pins and scripts survive.

### Verified against real systems

- A scratch org created from a dev hub: validation deploy, coverage extraction
  (100%), the coverage gate and a real deployment.
- A production sandbox, read-only: dry-run validation deploy, and the negative
  path where a deploy reports no coverage.
- `backlog-mcp-server` v0.20.4 over stdio: all tool names and parameter schemas
  in this kit come from its `tools/list` response, not from documentation.
