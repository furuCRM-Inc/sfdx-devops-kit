# Review checklist

A reviewer's pass list. `/sfdx-review` walks the same order, so a human and the
agent produce comparable results.

## Before reading code

- [ ] The branch name resolves to a Backlog ticket (`npx sfdx-devops-kit ticket`).
- [ ] The delivered metadata list matches the ticket's scope
      (`npx sfdx-devops-kit deliverables`).
- [ ] CI is green, or the failure is understood.

## Apex

- [ ] No SOQL or DML in a loop; bulk-safe for 200 records.
- [ ] Sharing keyword declared deliberately.
- [ ] Writing entry points enforce CRUD/FLS, or state why they run in system mode.
- [ ] Exceptions wrapped for the UI; nothing swallowed.
- [ ] No hardcoded IDs; no environment values in code.
- [ ] Async work (future/queueable/batch) is idempotent and retry-safe.

## Tests

- [ ] New logic has tests for the happy path, the error path and bulk volume.
- [ ] Assertions check values, not just absence of exceptions.
- [ ] No `SeeAllData=true`; data built in the test.
- [ ] Permission-sensitive logic tested with `System.runAs`.
- [ ] Org-wide coverage stays at or above the configured threshold.

## LWC

- [ ] Inbound `@api` properties treated as read-only.
- [ ] Apex errors surfaced to the user.
- [ ] No layout thrash or Apex calls in `renderedCallback`.
- [ ] Accessibility basics: labels, keyboard reachability, focus handling.

## Metadata

- [ ] Profile and permission set diffs are minimal and intentional.
- [ ] Field-level security changes are described on the ticket.
- [ ] Validation rules and triggers were not disabled to force a deployment.
- [ ] Deletions are routed through `destructiveChanges.xml`.
- [ ] Layouts, FlexiPages and translations updated for new fields where users see them.

## Deployment readiness

- [ ] Validation deploy against the integration sandbox passes.
- [ ] The manifest for this ticket deploys on its own
      (`npx sfdx-devops-kit deliverables --format package-xml`).
- [ ] Post-deploy steps (data fixes, permission set assignment, scheduled jobs)
      are written on the ticket.
