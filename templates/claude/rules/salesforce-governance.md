# Salesforce working rules for this project

Applies to every Salesforce change an agent makes here.

## Read efficiently

This project integrates **rtk-sf** by default. Before opening a raw file, use its
MCP tools — they return compressed specs instead of whole sources:

| Task | Tool |
|---|---|
| Find a component | `search_codebase(query)` |
| Read a component's spec | `query_compressed_spec(component_name)` |
| Read an Apex class before editing | `get_class_skeleton(component_name, focus_methods)` |
| Blast radius before editing | `get_relations(component_name)` |
| Object fields for data work | `get_object_schema(object_name)` |
| Record types | `get_record_types(object_name)` |
| LWC exposure and targets | `get_lwc_targets()` |
| Natural-language data question | `nl_to_soql(user_input)` |
| Deploy / retrieve / run tests quietly | `sf_command(action, target_org, …)` |
| Write discovered business logic back | `annotate_component(component_name, key, value)` |

If the tools are not available, say so once and fall back to targeted reads. Do
not dump whole metadata folders into context.

## Write carefully

- Follow `knowledge/sfdx/coding-rules.md`. It is the project's rule set, and the
  review skill enforces it.
- New Apex comes with tests in the same change, not "later".
- Never disable a validation rule, trigger or test to make a deployment pass.
- Never write a 15/18-character ID into code or metadata.

## Deploy carefully

- Validate before deploying: `--dry-run` against the integration sandbox.
- `--manifest`, `--source-dir` and `--metadata` cannot be combined on
  `sf project deploy start`; pick one.
- Never deploy to a production environment without being asked explicitly in that
  turn. A prior approval for a sandbox is not approval for production.
- Ask before any destructive operation: `destructiveChanges.xml`, record deletion,
  or a mass data update.

## Record the work

- Every implementation ticket gets its delivered metadata recorded on it
  (`/sfdx-deliverables`, or `/sfdx-review` which includes the list).
- Ticket status moves only through the mapping in `sfdx-pipeline.config.yml`, and
  never forward over a critical review finding.

## Handle secrets

- Auth URLs, session IDs and org credentials never enter a commit, a ticket
  comment, a log or a generated document.
- CI reads each org's auth URL from the GitHub Secret named in
  `npx sfdx-devops-kit validate` output.
