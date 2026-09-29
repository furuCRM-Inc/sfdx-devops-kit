/**
 * Deliverables are what gets written onto a ticket, so the mapping from file
 * paths to Salesforce components has to be right: a bundle is one component, a
 * `-meta.xml` companion is not a second one, and a field belongs to its object.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyPath,
  deriveDeliverables,
  parseNameStatus,
  renderMarkdown,
  renderPackageXml,
} from "../src/deliverables.mjs";
import { extractTicketKey, statusFor, ticketContext } from "../src/backlog.mjs";
import { validateConfig } from "../src/config.mjs";

const PREFIX = "force-app/main/default";

test("Apex, triggers and pages classify by their own file", () => {
  assert.deepEqual(classifyPath(`${PREFIX}/classes/OrderService.cls`), {
    type: "ApexClass",
    name: "OrderService",
    metadata: true,
  });
  assert.equal(classifyPath(`${PREFIX}/classes/OrderService.cls-meta.xml`).name, "OrderService");
  assert.equal(classifyPath(`${PREFIX}/triggers/OrderTrigger.trigger`).type, "ApexTrigger");
  assert.equal(classifyPath(`${PREFIX}/pages/OrderPdf.page`).type, "ApexPage");
});

test("bundles classify by directory, not by each file inside", () => {
  for (const file of ["orderList.js", "orderList.html", "orderList.js-meta.xml", "helper.js"]) {
    const classified = classifyPath(`${PREFIX}/lwc/orderList/${file}`);
    assert.equal(classified.type, "LightningComponentBundle");
    assert.equal(classified.name, "orderList");
  }
  assert.deepEqual(classifyPath(`${PREFIX}/aura/OrderPanel/OrderPanel.cmp`), {
    type: "AuraDefinitionBundle",
    name: "OrderPanel",
    metadata: true,
  });
});

test("object children carry their object prefix", () => {
  assert.deepEqual(classifyPath(`${PREFIX}/objects/Order__c/fields/Status__c.field-meta.xml`), {
    type: "CustomField",
    name: "Order__c.Status__c",
    metadata: true,
  });
  assert.equal(
    classifyPath(`${PREFIX}/objects/Order__c/validationRules/Status_Req.validationRule-meta.xml`).name,
    "Order__c.Status_Req",
  );
  assert.equal(
    classifyPath(`${PREFIX}/objects/Account/recordTypes/Partner.recordType-meta.xml`).type,
    "RecordType",
  );
  assert.deepEqual(classifyPath(`${PREFIX}/objects/Order__c/Order__c.object-meta.xml`), {
    type: "CustomObject",
    name: "Order__c",
    metadata: true,
  });
});

test("flows, permission sets and flexipages classify correctly", () => {
  assert.equal(classifyPath(`${PREFIX}/flows/Order_Followup.flow-meta.xml`).type, "Flow");
  assert.equal(
    classifyPath(`${PREFIX}/permissionsets/Order_Manager.permissionset-meta.xml`).type,
    "PermissionSet",
  );
  assert.equal(classifyPath(`${PREFIX}/flexipages/Order_Record.flexipage-meta.xml`).type, "FlexiPage");
});

test("non-metadata paths are labelled, not mistaken for components", () => {
  // A GitHub workflow lives in a `workflows` folder too; only paths under a
  // package directory may be classified as Salesforce metadata.
  assert.deepEqual(classifyPath(".github/workflows/sfdx-ci-cd.yml"), {
    type: "CI configuration",
    name: ".github/workflows/sfdx-ci-cd.yml",
    metadata: false,
  });
  assert.equal(
    classifyPath(`${PREFIX}/workflows/Account.workflow-meta.xml`).type,
    "Workflow",
    "a real Salesforce workflow still classifies",
  );
  assert.equal(classifyPath("src/main/default/classes/Foo.cls", ["src"]).type, "ApexClass");
  assert.equal(classifyPath("tests/e2e/order.spec.js").metadata, false);
  assert.equal(classifyPath("knowledge/sfdx/coding-rules.md").type, "Documentation");
});

test("a diff collapses to one entry per component", () => {
  const entries = parseNameStatus(
    [
      `M\t${PREFIX}/classes/OrderService.cls`,
      `M\t${PREFIX}/classes/OrderService.cls-meta.xml`,
      `A\t${PREFIX}/lwc/orderList/orderList.js`,
      `A\t${PREFIX}/lwc/orderList/orderList.html`,
      `A\t${PREFIX}/lwc/orderList/orderList.js-meta.xml`,
      `A\t${PREFIX}/objects/Order__c/fields/Status__c.field-meta.xml`,
      `D\t${PREFIX}/classes/LegacyService.cls`,
      `M\ttests/e2e/order.spec.js`,
    ].join("\n"),
  );

  const { components, other, counts } = deriveDeliverables(entries);
  assert.deepEqual(
    components.map((entry) => `${entry.type} ${entry.name} ${entry.change}`),
    [
      "ApexClass LegacyService deleted",
      "ApexClass OrderService modified",
      "CustomField Order__c.Status__c added",
      "LightningComponentBundle orderList added",
    ],
  );
  assert.equal(counts.ApexClass, 2);
  assert.equal(other.length, 1);
});

test("a bundle with both added and modified files counts as modified", () => {
  const entries = parseNameStatus(
    [`A\t${PREFIX}/lwc/orderList/newHelper.js`, `M\t${PREFIX}/lwc/orderList/orderList.js`].join("\n"),
  );
  const { components } = deriveDeliverables(entries);
  assert.equal(components.length, 1);
  assert.equal(components[0].change, "modified");
});

test("renames report the new path", () => {
  const entries = parseNameStatus(
    `R100\t${PREFIX}/classes/Old.cls\t${PREFIX}/classes/New.cls`,
  );
  assert.deepEqual(entries, [{ status: "R", path: `${PREFIX}/classes/New.cls` }]);
  const { components } = deriveDeliverables(entries);
  assert.equal(components[0].name, "New");
});

test("the Backlog comment lists components with counts", () => {
  const entries = parseNameStatus(
    [`M\t${PREFIX}/classes/OrderService.cls`, `A\t${PREFIX}/flows/Order_Followup.flow-meta.xml`].join("\n"),
  );
  const markdown = renderMarkdown(deriveDeliverables(entries), {
    ticket: "DEMO-12",
    branch: "feature/DEMO-12-order",
    base: "origin/main",
  });
  assert.match(markdown, /DEMO-12/);
  assert.match(markdown, /\| ApexClass \| `OrderService` \| modified \|/);
  assert.match(markdown, /\| Flow \| `Order_Followup` \| added \|/);
  assert.match(markdown, /ApexClass 1 \/ Flow 1/);
});

test("an empty diff says so instead of rendering an empty table", () => {
  const markdown = renderMarkdown(deriveDeliverables([]), { ticket: "DEMO-1" });
  assert.match(markdown, /メタデータの変更はありません/);
  assert.ok(!markdown.includes("| --- |"));
});

test("package.xml groups by type and excludes deletions with an explanation", () => {
  const entries = parseNameStatus(
    [
      `M\t${PREFIX}/classes/OrderService.cls`,
      `A\t${PREFIX}/classes/AuditService.cls`,
      `A\t${PREFIX}/objects/Order__c/fields/Status__c.field-meta.xml`,
      `D\t${PREFIX}/classes/LegacyService.cls`,
    ].join("\n"),
  );
  const xml = renderPackageXml(deriveDeliverables(entries), { apiVersion: "62.0" });

  assert.match(xml, /<members>AuditService<\/members>\s*<members>OrderService<\/members>\s*<name>ApexClass<\/name>/);
  assert.match(xml, /<members>Order__c\.Status__c<\/members>\s*<name>CustomField<\/name>/);
  assert.ok(!xml.includes("<members>LegacyService</members>"), "deletions are not deployable here");
  assert.match(xml, /destructiveChanges\.xml: ApexClass LegacyService/);
  assert.match(xml, /<version>62\.0<\/version>/);
});

// ---------------------------------------------------------------------------
// Backlog ticket resolution
// ---------------------------------------------------------------------------

test("ticket keys come out of branch names in the shapes teams use", () => {
  const options = { project_key: "SFDC_PROJ", branch_pattern: "([A-Z][A-Z0-9_]*-\\d+)" };
  assert.equal(extractTicketKey("feature/SFDC_PROJ-123-add-field", options).key, "SFDC_PROJ-123");
  assert.equal(extractTicketKey("SFDC_PROJ-7", options).key, "SFDC_PROJ-7");
  assert.equal(extractTicketKey("bugfix/sfdc_proj-9-fix", options).key, "SFDC_PROJ-9");
});

test("a key from another project is refused rather than moving the wrong ticket", () => {
  const result = extractTicketKey("feature/OTHER-5-x", { project_key: "SFDC_PROJ" });
  assert.equal(result.key, null);
  assert.match(result.reason, /outside project SFDC_PROJ/);
});

test("a branch without a key explains itself", () => {
  const result = extractTicketKey("main", { project_key: "SFDC_PROJ" });
  assert.equal(result.key, null);
  assert.match(result.reason, /does not contain a ticket key/);
});

test("ticketContext reports the mapping alongside the key", () => {
  const { config } = validateConfig({
    version: "1.0",
    project_name: "demo",
    environments: { st: { alias: "A", type: "sandbox", is_test_target: true } },
    backlog_integration: { project_key: "DEMO" },
  });
  const context = ticketContext(config, { branch: "feature/DEMO-42-thing" });
  assert.equal(context.ticket, "DEMO-42");
  assert.equal(context.status_mapping.review_ready, "処理済み");
  assert.equal(statusFor(config, "in_progress"), "処理中");
  assert.throws(() => statusFor(config, "archived"), /No Backlog status mapped/);
});
