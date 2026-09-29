# Pipeline samples

Complete, copy-ready configurations for common team shapes, plus the output each
one produces. Every sample below was run through `validate` and `plan`.

- [1. Minimal — one sandbox](#1-minimal--one-sandbox)
- [2. Standard — dev → ST → UAT → production](#2-standard--dev--st--uat--production)
- [3. Many environments — per-developer sandboxes, SIT, pre-prod, training](#3-many-environments--per-developer-sandboxes-sit-pre-prod-training)
- [4. Release-manifest driven production](#4-release-manifest-driven-production)
- [5. Strict quality gates](#5-strict-quality-gates)
- [6. No AI, no Backlog — pipeline only](#6-no-ai-no-backlog--pipeline-only)
- [What a run looks like](#what-a-run-looks-like)
- [What CI looks like](#what-ci-looks-like)

---

## 1. Minimal — one sandbox

The smallest configuration that does something useful: validate, test, deploy.

```yaml
version: "1.0"
project_name: "small-team-crm"

environments:
  st:
    alias: "STSandbox"
    type: "sandbox"
    is_test_target: true

pipeline_settings:
  lint: { enabled: true }
  prettier: { enabled: true }
  code_analyzer: { enabled: true, severity_threshold: 3 }
  validate_deploy: { enabled: true }
  unit_test:
    { enabled: true, test_level: "RunLocalTests", coverage_threshold: 75 }
  deploy: { enabled: true }
  integration_test: { enabled: false }
  e2e_test: { enabled: false }
  documentation: { enabled: true }

backlog_integration:
  project_key: "CRM"
```

---

## 2. Standard — dev → ST → UAT → production

The shape most teams land on. Personal dev sandbox for building, ST for CI,
UAT for acceptance, production behind a GitHub environment approval.

```yaml
version: "1.0"
project_name: "acme-crm"

environments:
  dev:
    alias: "DevSandbox"
    type: "sandbox"
  st:
    alias: "STSandbox"
    type: "sandbox"
    is_test_target: true # CI validates and runs E2E here
  uat:
    alias: "UATSandbox"
    type: "sandbox"
  prod:
    alias: "Production"
    type: "production"
    deploy_manifest: "manifest/package.xml"

pipeline_settings:
  lint: { enabled: true }
  prettier: { enabled: true }
  code_analyzer:
    enabled: true
    engine: "code-analyzer"
    rule_selector: "Recommended"
    severity_threshold: 3
  validate_deploy: { enabled: true }
  unit_test:
    enabled: true
    test_level: "RunLocalTests"
    coverage_threshold: 80
  deploy: { enabled: true }
  integration_test: { enabled: false }
  e2e_test: { enabled: true, tool: "playwright" }
  documentation: { enabled: true, doc_type: "all", output_dir: "docs" }

ai_assist:
  rtk_sf: { enabled: true, required: false }

backlog_integration:
  project_key: "ACME"
  status_mapping:
    in_progress: "処理中"
    review_ready: "処理済み"
    closed: "完了"
```

Deploying to any of them is a flag, not an edit:

```bash
npx sfdx-devops-kit run --env dev        # your own sandbox
npx sfdx-devops-kit run --env uat        # acceptance
npx sfdx-devops-kit run --env prod       # release (validate first!)
```

---

## 3. Many environments — per-developer sandboxes, SIT, pre-prod, training

**There is no limit on the number of environments.** `environments` is an open
map: add a key, get a secret name and a `--env` target. This sample declares ten
and validates cleanly.

```yaml
version: "1.0"
project_name: "enterprise-crm"

environments:
  dev_alice:
    alias: "DevAlice"
    type: "sandbox"
  dev_bob:
    alias: "DevBob"
    type: "sandbox"
  dev_carol:
    alias: "DevCarol"
    type: "sandbox"
  feature_qa:
    alias: "FeatureQA"
    type: "sandbox"
    source_dir: "force-app"
  st:
    alias: "STSandbox"
    type: "sandbox"
    is_test_target: true
  sit:
    alias: "SITSandbox"
    type: "sandbox"
  uat:
    alias: "UATSandbox"
    type: "sandbox"
  "pre-prod":
    alias: "PreProd"
    type: "sandbox"
    deploy_manifest: "manifest/release.xml"
  training:
    alias: "TrainingOrg"
    type: "developer"
  prod:
    alias: "Production"
    type: "production"
    deploy_manifest: "manifest/package.xml"
    auth_secret: "SF_PRODUCTION_AUTH_URL_ROTATED" # override the derived name
```

`validate` output for exactly this file:

```text
config: sfdx-pipeline.config.yml
  ✔ valid — 10 environment(s)

Required GitHub Secrets:
  SF_DEV_ALICE_AUTH_URL    → DevAlice (sandbox)
  SF_DEV_BOB_AUTH_URL      → DevBob (sandbox)
  SF_DEV_CAROL_AUTH_URL    → DevCarol (sandbox)
  SF_FEATURE_QA_AUTH_URL   → FeatureQA (sandbox)
  SF_ST_AUTH_URL           → STSandbox (sandbox)
  SF_SIT_AUTH_URL          → SITSandbox (sandbox)
  SF_UAT_AUTH_URL          → UATSandbox (sandbox)
  SF_PRE_PROD_AUTH_URL     → PreProd (sandbox)
  SF_TRAINING_AUTH_URL     → TrainingOrg (developer)
  SF_PRODUCTION_AUTH_URL_ROTATED → Production (production)
```

Rules that still apply at any scale:

- **Exactly one** environment sets `is_test_target: true` (CI's default target).
- **One deployment selector** per environment (`deploy_manifest`, `source_dir` or
  `metadata` — never two; the Salesforce CLI rejects the combination).
- A key becomes `SF_<KEY>_AUTH_URL` (`pre-prod` → `SF_PRE_PROD_AUTH_URL`); override
  with `auth_secret` when you rotate or share a secret.

Run against any of them:

```bash
npx sfdx-devops-kit plan --env dev_carol
npx sfdx-devops-kit run  --env pre-prod --skip e2e_test
gh workflow run sfdx-ci-cd.yml -f environment=sit
```

---

## 4. Release-manifest driven production

Deploy only what a release contains, generated from the diff between `main` and
`develop`:

```yaml
environments:
  prod:
    alias: "Production"
    type: "production"
    deploy_manifest: "manifest/package.xml"
```

```bash
# Freeze the release contents
npx sfdx-devops-kit deliverables --base origin/main --head origin/develop \
  --format package-xml --out manifest/package.xml

# Validate against production before releasing
npx sfdx-devops-kit run validate_deploy unit_test --env prod
```

Deletions cannot ride in `package.xml`; the generated manifest says so in a
comment, and they need `destructiveChanges.xml`.

---

## 5. Strict quality gates

For a codebase that has earned it — or a regulated one that requires it:

```yaml
pipeline_settings:
  code_analyzer:
    enabled: true
    severity_threshold: 4 # fail on Low and worse, not just Moderate
    rule_selector: "Recommended:Security"
  unit_test:
    enabled: true
    test_level: "RunAllTestsInOrg" # every test, not just local
    coverage_threshold: 90
  e2e_test:
    enabled: true
    tool: "playwright"
  integration_test:
    enabled: true
    tool: "newman"
    command: "npx newman run tests/integration/regression.json --env-var baseUrl=$E2E_BASE_URL"
```

And for a specific release that must only run named tests:

```yaml
unit_test:
  enabled: true
  test_level: "RunSpecifiedTests"
  tests:
    - OpportunityDiscountControllerTest
    - AccountNameFormatterTest
  coverage_threshold: 75
```

`validate` rejects `RunSpecifiedTests` with an empty `tests` list, so this cannot
be half-configured.

---

## 6. No AI, no Backlog — pipeline only

The kit works as a plain CI/CD pipeline. Turn the rest off:

```yaml
ai_assist:
  rtk_sf:
    enabled: false # skips the documentation stage

pipeline_settings:
  documentation: { enabled: false }

backlog_integration:
  project_key: "" # ticket resolution is then reported as unavailable, not guessed
```

`plan` states why each stage is inactive, so nothing is silently off:

```text
· documentation     Generate system documentation (rtk-sf) — skipped: ai_assist.rtk_sf.enabled is false
```

---

## What a run looks like

A real run against a scratch org, with the Apex tests executing inside the
validation deploy and the coverage gate reading that result:

```text
$ npx sfdx-devops-kit run --skip e2e_test
▶ lint: Lint (ESLint)
  ✔ ok
▶ prettier: Format check (Prettier)
  ✔ ok
▶ code_analyzer: Salesforce Code Analyzer
  ✔ No violations at severity <= 3 (2 total finding(s))
▶ validate_deploy: Validation deploy to spk-loop (dry run)
  ✔ Succeeded: 2 component(s); coverage 100%
▶ unit_test: Apex unit tests and coverage gate
  ✔ Coverage 100% meets the 75% threshold
▶ deploy: Deploy to spk-loop
  ✔ Succeeded: 2 component(s); coverage 100%
· integration_test: skipped — pipeline_settings.integration_test.enabled is false
· e2e_test: skipped — excluded by --skip e2e_test
▶ documentation: Generate system documentation (rtk-sf)
  ✔ ok

✔ pipeline passed — 6/6 stage(s) passed, coverage 100%
```

Failures name the cause rather than an exit code:

```text
✖ unit_test: Coverage 68% is below the 75% threshold

✖ validate_deploy: Deploy failed — 1 component error(s), e.g.
  ApexClass OrderService: Variable does not exist: Status__c

✖ validate_deploy: Deploy failed — org coverage requirement not met:
  選択された Apex Class のテストカバー率は 0% です。少なくとも 75% 以上の
  テストカバー率が必要です。

✖ code_analyzer: Code Analyzer could not start 3 engine(s) (pmd, cpd, sfge),
  so the code was not analyzed: Could not locate Java v11.0.0+.
```

Preview without touching an org:

```text
$ npx sfdx-devops-kit run --dry-run --env uat
▶ validate_deploy: Validation deploy to UATSandbox (dry run)
    gate: deployment must validate without component errors
    $ sf project deploy start --json --target-org UATSandbox --test-level RunLocalTests --dry-run --wait 60
▶ unit_test: Apex unit tests and coverage gate
    gate: org-wide coverage must reach 80%

✔ 8 stage(s) planned — nothing was executed (--dry-run)
```

---

## What CI looks like

The generated workflow derives its steps from the same config.

| Job            | Runs when                | Contents                                                                                    |
| -------------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| `plan`         | always                   | `validate`, then publishes the plan to the step summary and an `enabled` map for later jobs |
| `quality`      | always                   | ESLint, Prettier, Code Analyzer (with a JDK for the Java engines)                           |
| `validate`     | always                   | Authorizes the target org, dry-run deploy, coverage gate                                    |
| `deploy`       | **not** on pull requests | Real deploy, integration, E2E, documentation                                                |
| `deliverables` | pull requests            | Metadata list and `package.xml` as artifacts                                                |

Every optional step is gated by one expression, so disabling a stage in the
config disables it in CI without touching the workflow:

```yaml
- name: Salesforce Code Analyzer
  if: fromJSON(needs.plan.outputs.plan).enabled.code_analyzer
  run: npx sfdx-devops-kit run code_analyzer
```

Org credentials are read by the name the plan resolves, never hardcoded:

```yaml
env:
  SFDX_AUTH_URL: ${{ secrets[needs.plan.outputs.auth_secret] }}
```

Trigger a specific environment by hand:

```bash
gh workflow run sfdx-ci-cd.yml -f environment=uat
gh workflow run sfdx-ci-cd.yml -f environment=prod -f deploy=true
```
