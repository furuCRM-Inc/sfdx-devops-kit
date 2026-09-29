# Configuration reference

Every key in `sfdx-pipeline.config.yml`. Run `npx sfdx-devops-kit validate` after
any edit — it reports the YAML path of anything wrong and lists the GitHub Secrets
the environments need.

---

## Top level

| Key                   | Type   | Default        | Notes                             |
| --------------------- | ------ | -------------- | --------------------------------- |
| `version`             | string | `"1.0"`        | Only `1.0` is supported today     |
| `project_name`        | string | directory name | Appears in generated documents    |
| `environments`        | map    | —              | At least one is required          |
| `pipeline_settings`   | map    | see below      | Stage settings                    |
| `ai_assist`           | map    | see below      | rtk-sf integration                |
| `backlog_integration` | map    | see below      | Ticket keys, statuses, MCP server |

---

## `environments.<key>`

```yaml
environments:
  st:
    alias: "STSandbox"
    type: "sandbox"
    is_test_target: true
    deploy_manifest: "manifest/package.xml"
    auth_secret: "SF_CUSTOM_SECRET"
```

| Key               | Type          | Required | Notes                                                                                                    |
| ----------------- | ------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `alias`           | string        | yes      | Org alias or username as the Salesforce CLI knows it                                                     |
| `type`            | enum          | yes      | `sandbox`, `production`, `scratch`, `developer`                                                          |
| `is_test_target`  | bool          | no       | The default target for CI validation and E2E. **Exactly one** environment may set it; production may not |
| `deploy_manifest` | string        | no       | `--manifest` value                                                                                       |
| `source_dir`      | string        | no       | `--source-dir` value                                                                                     |
| `metadata`        | string / list | no       | `--metadata` value(s)                                                                                    |
| `auth_secret`     | string        | no       | Overrides the derived secret name                                                                        |

**Only one deployment selector per environment.** `sf project deploy start`
rejects `--manifest`, `--source-dir` and `--metadata` in combination, so declaring
two is a validation error rather than a failed deployment. With none, the project's
default package directories are deployed.

Secret names are derived as `SF_<KEY>_AUTH_URL` (`st` → `SF_ST_AUTH_URL`,
`pre-prod` → `SF_PRE_PROD_AUTH_URL`).

---

## `pipeline_settings`

Stages run in this order. Every stage takes `enabled` (bool, required).

### `lint`, `prettier`

| Key             | Default                             | Notes                                     |
| --------------- | ----------------------------------- | ----------------------------------------- |
| `command`       | `npm run lint` / `npm run prettier` | Replace with your own                     |
| `fail_on_error` | `true`                              | `false` records the failure and continues |

### `code_analyzer`

| Key                  | Default                      | Notes                                                                               |
| -------------------- | ---------------------------- | ----------------------------------------------------------------------------------- |
| `engine`             | `code-analyzer`              | `code-analyzer` (v5, `sf code-analyzer run`) or `scanner` (legacy `sf scanner run`) |
| `rule_selector`      | `Recommended`                | v5 selector: engine, severity, tag, or a combination                                |
| `pmd_rule_set`       | `""`                         | Legacy engine only → `--pmdconfig`                                                  |
| `config_file`        | unset                        | v5 → `--config-file` (a `code-analyzer.yml`)                                        |
| `severity_threshold` | `3`                          | Fail at this severity **or worse**. 1 Critical, 2 High, 3 Moderate, 4 Low, 5 Info   |
| `target`             | `force-app`                  | v5 `--workspace`, legacy `--target`                                                 |
| `output_file`        | `code-analyzer-results.json` | Parsed for the gate and uploaded by CI                                              |

The PMD, CPD and SFGE engines are Java-based. Without a JDK 11+ they fail to
start, and the kit reports that as an infrastructure failure rather than as code
findings. `rule_selector: eslint` needs no Java.

### `validate_deploy`, `deploy`

Only `enabled`. Commands are derived from the environment and `unit_test`:

```text
sf project deploy start --json --target-org <alias> [<selector>] --test-level <level> [--dry-run] --wait 60
```

CI runs `deploy` only when the event is not a pull request, so a fork PR cannot
deploy into an org.

### `unit_test`

| Key                  | Default         | Notes                                                                 |
| -------------------- | --------------- | --------------------------------------------------------------------- |
| `test_level`         | `RunLocalTests` | `NoTestRun`, `RunSpecifiedTests`, `RunLocalTests`, `RunAllTestsInOrg` |
| `tests`              | `[]`            | Required when `test_level` is `RunSpecifiedTests`                     |
| `coverage_threshold` | `75`            | 0–100                                                                 |

This stage runs no commands: Apex tests execute inside the validation deploy, and
the gate reads that result, so tests are not run twice. Coverage that cannot be
measured (for example `NoTestRun`) **fails** the gate rather than passing quietly.

### `integration_test`, `e2e_test`

| Key       | Default                 | Notes                        |
| --------- | ----------------------- | ---------------------------- |
| `tool`    | `newman` / `playwright` | Or `custom`                  |
| `command` | tool default            | Required when `tool: custom` |

### `documentation`

| Key          | Default  | Notes                                                   |
| ------------ | -------- | ------------------------------------------------------- |
| `tool`       | `rtk-sf` | The only wired tool                                     |
| `doc_type`   | `all`    | `all`, `function_matrix`, `sequence_diagrams`, `erd`, … |
| `output_dir` | `docs`   | Where the document set is written                       |

Skipped when rtk-sf is unavailable, unless `ai_assist.rtk_sf.required` is true.

---

## `ai_assist.rtk_sf`

```yaml
ai_assist:
  rtk_sf:
    enabled: true
    required: false
    python: "python3"
    index_on_setup: true
    register_mcp: true
```

| Key              | Default   | Notes                                                            |
| ---------------- | --------- | ---------------------------------------------------------------- |
| `enabled`        | `true`    | Integrated by default                                            |
| `required`       | `false`   | `true` makes a missing rtk-sf fail the build instead of skipping |
| `python`         | `python3` | Interpreter that has rtk-sf installed                            |
| `index_on_setup` | `true`    | `setup-project.sh` runs `rtk_sf index`                           |
| `register_mcp`   | `true`    | `setup-project.sh` registers the MCP server                      |

---

## `backlog_integration`

```yaml
backlog_integration:
  project_key: "PROJ"
  branch_pattern: "([A-Z][A-Z0-9_]*-\\d+)"
  status_mapping:
    in_progress: "処理中"
    review_ready: "処理済み"
    closed: "完了"
  status_ids: {}
  mcp:
    server_name: "backlog"
    runtime: "docker"
    toolsets: "space,project,issue"
    tool_prefix: ""
  deliverables:
    post_on_review: true
    include_package_xml: true
    include_non_metadata: true
```

| Key                                 | Default                  | Notes                                                                                |
| ----------------------------------- | ------------------------ | ------------------------------------------------------------------------------------ |
| `project_key`                       | `""`                     | A key from another project is refused, so a stray match cannot move the wrong ticket |
| `branch_pattern`                    | `([A-Z][A-Z0-9_]*-\d+)`  | Matched case-insensitively against the branch name                                   |
| `status_mapping.*`                  | 処理中 / 処理済み / 完了 | All three are required                                                               |
| `comment_format`                    | `markdown`               | `markdown` or `backlog`; must match the project's text formatting rule               |
| `status_ids`                        | `{}`                     | Status **name → numeric id**, for custom statuses                                    |
| `mcp.server_name`                   | `backlog`                | Name in `.mcp.json`                                                                  |
| `mcp.runtime`                       | `docker`                 | `docker` or `npx`                                                                    |
| `mcp.toolsets`                      | `space,project,issue`    | `--enable-toolsets` value                                                            |
| `mcp.tool_prefix`                   | `""`                     | Set when the server runs with `--prefix`                                             |
| `deliverables.post_on_review`       | `true`                   | `/sfdx-review` posts the component list                                              |
| `deliverables.include_package_xml`  | `true`                   | Include a per-ticket manifest                                                        |
| `deliverables.include_pr_link`      | `true`                   | Add the PR URL (via `gh`, falling back to a compare link)                            |
| `deliverables.include_non_metadata` | `true`                   | List test/CI/doc changes in a collapsed section                                      |

### Status ids

[nulab/backlog-mcp-server](https://github.com/nulab/backlog-mcp-server) exposes no
status-listing tool (verified against v0.20.4: 63 tools, none for statuses), so a
status name cannot be resolved to an id at runtime. Backlog's built-in statuses
have fixed ids in every project and are resolved automatically:

| Name                 | id  |
| -------------------- | --- |
| 未対応 / Open        | 1   |
| 処理中 / In Progress | 2   |
| 処理済み / Resolved  | 3   |
| 完了 / Closed        | 4   |

A project with custom statuses lists them explicitly:

```yaml
status_ids:
  レビュー待ち: 5
  リリース待ち: 6
```

`validate` warns about any mapped status that is neither built-in nor listed. In
that case the skills post their comment and report that the status was left
unchanged — they never guess an id, because a wrong one moves the ticket to an
unrelated state.

### Credentials

`BACKLOG_DOMAIN` and `BACKLOG_API_KEY` live in the environment and are passed
through by `.mcp.json`. They never belong in this file or in the repository.

---

## Checking the resolved configuration

```bash
npx sfdx-devops-kit validate          # errors, warnings, required secrets
npx sfdx-devops-kit plan --env st     # the stages, gates and exact commands
npx sfdx-devops-kit plan --json       # machine-readable, including `enabled`
npx sfdx-devops-kit backlog --phase review_ready   # ticket, statusId, MCP calls
npx sfdx-devops-kit doctor            # toolchain, Java, rtk-sf, Backlog wiring
```
