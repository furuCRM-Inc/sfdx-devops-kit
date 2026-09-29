---
name: sfdx-deliverables
description: Record the metadata a ticket delivered (Apex, LWC, objects, fields, flows, permission sets) on its Backlog ticket, with an optional package.xml for exactly that change. Use when asked to report deliverables, log what a ticket shipped, update a ticket with the metadata list, or prepare a deployment manifest for one ticket.
---

# /sfdx-deliverables — record what a ticket shipped

Every implementation ticket carries the list of metadata it delivered. This skill
derives that list from git rather than from memory, so it matches the branch
exactly.

## 1. Derive the list

```bash
npx sfdx-devops-kit ticket --json
npx sfdx-devops-kit deliverables --base origin/main --format md
npx sfdx-devops-kit deliverables --base origin/main --format package-xml
```

Adjust `--base` to the branch this work will merge into (`origin/develop` on a
develop-first flow). If the base ref is missing locally, run `git fetch origin`
first — do not silently fall back to a different base, because that would change
the component list.

The Markdown output is already a Backlog-ready comment: the ticket key, the
branch, the **pull request link**, a table of `type | API name | change`, per-type
counts, and a collapsed list of non-metadata changes (tests, CI config, docs).

The PR link comes from `gh pr view` for the current branch. Before the PR is
opened it falls back to a GitHub compare URL, which is marked as such — so a
reviewer is never handed a link that looks like a PR but is not one.

## 2. Sanity-check the list

Read it before posting, and confirm:

- Every component the ticket was supposed to deliver appears.
- Nothing unrelated appears — a stray `profiles/Admin.profile-meta.xml` or a
  retrieved-but-unwanted layout usually means an accidental `sf project retrieve`.
- Deletions are listed as `deleted`. `package.xml` cannot express a deletion, so
  those need `destructiveChanges.xml`; the generated manifest says so in a comment.

If something looks wrong, fix the branch rather than editing the generated list.

## 3. Post it

```bash
npx sfdx-devops-kit backlog --phase review_ready --base origin/main --json
```

That resolves the ticket key and prints the comment body. Post it with the
Backlog MCP server (nulab/backlog-mcp-server):

```text
add_issue_comment({ issueKey: "PROJ-142", content: "<the Markdown above>" })
```

When `backlog_integration.deliverables.include_package_xml` is true, include the
manifest in the same comment inside a fenced block. `add_issue_comment` accepts
`attachmentId`, so an already-uploaded file can be attached instead.

Do not change the ticket status here — status transitions belong to
`/sfdx-review`, which posts the review result alongside this list.

## 4. Confirm

Reply with the ticket key, the component count, and the per-type breakdown. If no
ticket key could be resolved from the branch, print the comment and say it was
not posted rather than guessing a ticket.
