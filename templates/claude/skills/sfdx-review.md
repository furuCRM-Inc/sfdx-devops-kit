---
name: sfdx-review
description: Review the current Salesforce change before opening a PR — governor limits, security, test quality, metadata risk — then record the result and the delivered metadata on the Backlog ticket. Use when the developer says /sfdx-review, asks for a pre-PR review, or is about to open a pull request for an SFDX change.
---

# /sfdx-review — pre-PR review for Salesforce changes

Review the working change against this project's rules, then report to Backlog.
Everything you need is derived from the repository: read
`sfdx-pipeline.config.yml` for thresholds and Backlog mapping, and
`knowledge/sfdx/coding-rules.md` plus `knowledge/sfdx/review-checklist.md` for
the rules to apply.

## 0. Gather context

```bash
npx sfdx-devops-kit ticket --json          # branch → Backlog key, status mapping
npx sfdx-devops-kit deliverables --json    # the metadata this change delivers
git diff --stat "$(git merge-base HEAD origin/main)"..HEAD
```

If `ticket` reports no key, continue the review and say plainly in your summary
that no Backlog ticket could be resolved from the branch name — do not guess a
ticket number.

## 1. Read the change efficiently

This project integrates **rtk-sf** by default. Prefer its MCP tools over reading
raw files, so a large class costs a few hundred tokens instead of thousands:

| Need                                       | Tool                                                |
| ------------------------------------------ | --------------------------------------------------- |
| A class's shape before judging a method    | `get_class_skeleton(component_name, focus_methods)` |
| What a component is and its fields         | `query_compressed_spec(component_name)`             |
| Blast radius of an edit                    | `get_relations(component_name)`                     |
| Object fields, picklists, validation rules | `get_object_schema(object_name)`                    |
| Existing record shapes                     | `soql_query(...)` or `nl_to_soql(...)`              |

If those tools are unavailable (rtk-sf not installed), fall back to `git diff`
and targeted file reads, and mention the fallback in the summary.

## 2. Apply the rules

Check the diff against `knowledge/sfdx/coding-rules.md`. At minimum:

- **Governor limits** — no SOQL or DML inside a loop; collections are bulkified;
  no unbounded queries in a trigger path.
- **Sharing and access** — every class declares `with sharing`,
  `without sharing` or `inherited sharing` deliberately; new `@AuraEnabled`
  entry points that write data enforce CRUD/FLS (`WITH USER_MODE`,
  `WITH SECURITY_ENFORCED`, `stripInaccessible`, or explicit describe checks).
- **Test quality** — no `SeeAllData=true`; assertions are meaningful rather than
  coverage padding; negative paths are covered.
- **Hardcoded IDs** — no 15/18-character IDs; record types resolved by
  DeveloperName; environment-specific values in custom metadata.
- **Metadata risk** — profile diffs that touch unrelated permissions, field-level
  security removals, `.forceignore` bypasses, validation rules deactivated
  without explanation.

Classify each finding as **critical** (must fix before merge), **major**
(should fix), or **minor** (suggestion). Cite file and line.

## 3. Report to Backlog

Get the exact calls to make, including the resolved status id:

```bash
npx sfdx-devops-kit backlog --phase review_ready --base origin/main
```

It prints the MCP server name, the ticket key, the `statusId`, and the comment
body. Issue the calls through the Backlog MCP server (nulab/backlog-mcp-server;
add `backlog_integration.mcp.tool_prefix` if the project sets one):

| Purpose         | Tool                | Arguments                |
| --------------- | ------------------- | ------------------------ |
| Read the ticket | `get_issue`         | `{ issueKey }`           |
| Post the review | `add_issue_comment` | `{ issueKey, content }`  |
| Move the status | `update_issue`      | `{ issueKey, statusId }` |

`update_issue` also accepts `comment`, so the comment and the status change can
be one call when you prefer.

The comment includes the **pull request link** automatically
(`backlog_integration.deliverables.include_pr_link`, on by default): `gh` resolves
it for the current branch, and before the PR exists a GitHub compare link is used
instead. Run this skill _after_ opening the PR when you want the real PR URL on
the ticket; run it before, and re-run after, when you want both the pre-PR review
and the final link.

Compose one comment with two parts:

1. **Review result** — findings grouped by severity, or an explicit "no findings".
2. **Delivered metadata** — paste the output of
   `npx sfdx-devops-kit deliverables --format md`. This is the record of what the
   ticket shipped, in Salesforce terms (type, API name, change), and it is
   required on every implementation ticket.

When `backlog_integration.deliverables.include_package_xml` is true, also attach
or paste `npx sfdx-devops-kit deliverables --format package-xml` so a reviewer
can deploy exactly this change.

## 4. Move the ticket, conditionally

- **No critical findings** → `update_issue` with the `statusId` for
  `backlog_integration.status_mapping.review_ready` (default `処理済み`, id 3).
- **Any critical finding** → leave the status as it is, and say why in the
  comment. Never move a ticket forward over a critical finding.
- **`statusId` unknown** — the `backlog` command prints
  `id unknown` when the project uses a custom status that is not in
  `backlog_integration.status_ids`. Post the comment, then say the status was left
  unchanged and what to add to the config. Never guess an id: a wrong one moves
  the ticket to an unrelated state.

State the status change (or the decision not to make one) in your reply so the
developer sees it without opening Backlog.

## 5. Summarize locally

Finish with a short terminal summary: counts by severity, the ticket key and
status, and the component count from `deliverables`. Keep the full detail in the
Backlog comment rather than repeating it here.

## Guardrails

- Review only what the diff contains. Do not refactor, and do not fix code as
  part of the review unless the developer asks.
- Never post an org's data, a session ID, or an auth URL into a ticket comment.
- If the Backlog MCP server is unavailable, print the comment you would have
  posted and say it was not sent — do not silently drop it.
