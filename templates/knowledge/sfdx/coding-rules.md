# Salesforce development and governance rules

The rules the AI review (`/sfdx-review`) and human reviewers apply to this
project. Edit this file to change what gets enforced — the skills read it rather
than carrying their own copy.

## 1. Governor limits

- **Never** run SOQL or DML inside a `for` loop. Query once into a collection,
  operate in memory, and DML once.
- Bulkify everything that can be invoked in bulk: triggers, `@InvocableMethod`,
  batch execute methods, queueable payloads. Assume 200 records per execution.
- Query only the fields you use, and bound every query with `WHERE` and `LIMIT`
  where the row count is not intrinsically small.
- Aggregate with SOQL aggregate functions instead of looping over full records.

## 2. Sharing and security

- Every class declares its sharing intent explicitly: `with sharing`,
  `without sharing`, or `inherited sharing`. An omitted keyword is a review
  finding, not a default.
- Any `@AuraEnabled` method that writes data enforces access: `WITH USER_MODE`
  on the query, `insert as user` / `update as user` on the DML, or
  `Security.stripInaccessible` / explicit `Schema.sObjectType…isUpdateable()`
  checks. Choosing system mode is allowed, but it must be deliberate and
  commented — it is not the same as enforcement.
- `@AuraEnabled(cacheable=true)` must not perform DML.
- Never surface raw exception text to the UI; wrap in `AuraHandledException` with
  a message a user can act on.

## 3. Test class quality

- `@IsTest` classes never use `SeeAllData=true`. Create the data the test needs,
  preferably through a shared test data factory.
- Assertions carry meaning: assert the resulting field values, record counts and
  error messages. A test that only calls a method to raise coverage is rejected.
- Cover the negative paths: validation failures, missing permissions
  (`System.runAs`), bulk volume, and the exception branches.
- Use `Test.startTest()` / `Test.stopTest()` around the code under test so
  governor limits are measured for the code, not the setup.

## 4. No hardcoded IDs or environment values

- No 15- or 18-character ID literals in Apex, LWC, flows or validation rules.
- Resolve record types by `DeveloperName`, profiles and permission sets by name,
  and queues by `DeveloperName`.
- Environment-specific endpoints, thresholds and feature switches live in custom
  metadata, custom settings or named credentials — not in code.

## 5. LWC

- No `@api` property mutated from inside the component; treat inbound properties
  as read-only.
- Errors from Apex are handled and surfaced to the user, never swallowed.
- Avoid `document.querySelector` on rendered DOM; use `this.refs` or
  `this.template.querySelector`.
- Keep an Apex round trip out of a render cycle: use `@wire` or an explicit
  handler, not `renderedCallback`.

## 6. Metadata hygiene

- Profile diffs contain only the change the ticket needs. A wholesale profile
  retrieve that rewrites unrelated permissions is a review finding.
- Field-level security and permission set changes are intentional and described
  on the ticket.
- Never deactivate a validation rule or trigger to make a deployment pass without
  recording why on the ticket.
- Deleted metadata goes through `destructiveChanges.xml`; it cannot ride in
  `package.xml`.

## 7. Deployment

- A validation deploy (`--dry-run`) against the integration sandbox must pass
  before a pull request is merged.
- `--manifest`, `--source-dir` and `--metadata` are mutually exclusive on
  `sf project deploy start`. Declare exactly one selector per environment in
  `sfdx-pipeline.config.yml`; passing two makes the CLI reject the command before
  it reaches the org.
- Coverage is checked against the org-wide figure the deployment reports, not a
  local estimate.
