/**
 * deliverables.mjs — turn a git diff into the metadata a ticket delivered.
 *
 * Every implementation ticket should record what it actually shipped, in
 * Salesforce terms rather than file terms: "ApexClass OrderService (modified),
 * CustomField Order__c.Status__c (added)" — not a list of 40 paths including
 * `-meta.xml` companions.
 *
 * This module maps SFDX source paths to metadata components, collapses bundles
 * and `-meta.xml` pairs into one entry each, and renders the result as a Backlog
 * comment, as JSON, or as a deployable `package.xml` for exactly that ticket.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Salesforce API version used when emitting package.xml. */
export const DEFAULT_API_VERSION = "62.0";

const CHANGE_LABELS = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied" };

/**
 * Directory-name → metadata type for components addressed by their own file.
 * Nested object children (fields, validation rules, …) are handled separately
 * because their API name is `Object.Child`.
 */
const DIRECTORY_TYPES = {
  classes: "ApexClass",
  triggers: "ApexTrigger",
  pages: "ApexPage",
  components: "ApexComponent",
  lwc: "LightningComponentBundle",
  aura: "AuraDefinitionBundle",
  flows: "Flow",
  flowDefinitions: "FlowDefinition",
  permissionsets: "PermissionSet",
  permissionsetgroups: "PermissionSetGroup",
  profiles: "Profile",
  flexipages: "FlexiPage",
  layouts: "Layout",
  labels: "CustomLabels",
  staticresources: "StaticResource",
  quickActions: "QuickAction",
  tabs: "CustomTab",
  applications: "CustomApplication",
  email: "EmailTemplate",
  reports: "Report",
  dashboards: "Dashboard",
  sharingRules: "SharingRules",
  customMetadata: "CustomMetadata",
  globalValueSets: "GlobalValueSet",
  standardValueSets: "StandardValueSet",
  duplicateRules: "DuplicateRule",
  matchingRules: "MatchingRule",
  namedCredentials: "NamedCredential",
  remoteSiteSettings: "RemoteSiteSetting",
  connectedApps: "ConnectedApp",
  contentassets: "ContentAsset",
  objects: "CustomObject",
  triggers_meta: "ApexTrigger",
  workflows: "Workflow",
  assignmentRules: "AssignmentRules",
  escalationRules: "EscalationRules",
  autoResponseRules: "AutoResponseRules",
  settings: "Settings",
  messageChannels: "LightningMessageChannel",
  platformEventChannels: "PlatformEventChannel",
  networks: "Network",
  sites: "CustomSite",
  prompts: "Prompt",
  genAiPlugins: "GenAiPlugin",
  genAiFunctions: "GenAiFunction",
  genAiPromptTemplates: "GenAiPromptTemplate",
  bots: "Bot",
};

/** Object sub-folder → metadata type, where the API name is `Object.Child`. */
const OBJECT_CHILD_TYPES = {
  fields: "CustomField",
  validationRules: "ValidationRule",
  recordTypes: "RecordType",
  listViews: "ListView",
  compactLayouts: "CompactLayout",
  webLinks: "WebLink",
  fieldSets: "FieldSet",
  businessProcesses: "BusinessProcess",
  indexes: "Index",
};

/** Package directories from sfdx-project.json, defaulting to force-app. */
export function readPackageDirectories(cwd = process.cwd()) {
  try {
    const project = JSON.parse(fs.readFileSync(path.join(cwd, "sfdx-project.json"), "utf8"));
    const dirs = (project.packageDirectories ?? [])
      .map((entry) => String(entry.path ?? "").replace(/^\.\//, "").replace(/\/$/, ""))
      .filter(Boolean);
    return dirs.length > 0 ? dirs : ["force-app"];
  } catch {
    return ["force-app"];
  }
}

/**
 * Classify one repository path.
 *
 * Salesforce metadata always lives under a package directory. Without that gate
 * a CI file such as `.github/workflows/ci.yml` matches the `workflows` folder
 * name and would be reported — and deployed — as a Salesforce Workflow.
 *
 * @param {string} filePath repo-relative path
 * @param {string[]} packageDirs package directories from sfdx-project.json
 * @returns {{type: string, name: string, metadata: boolean}}
 */
export function classifyPath(filePath, packageDirs = ["force-app"]) {
  const parts = filePath.split("/").filter(Boolean);

  const insidePackage = packageDirs.some((dir) => {
    const segments = dir.split("/").filter(Boolean);
    return segments.every((segment, index) => parts[index] === segment);
  });
  if (!insidePackage) {
    return { type: classifyNonMetadata(parts), name: filePath, metadata: false };
  }

  const objectsIndex = parts.indexOf("objects");
  if (objectsIndex !== -1 && parts.length > objectsIndex + 1) {
    const objectName = parts[objectsIndex + 1];
    const childFolder = parts[objectsIndex + 2];
    const childType = childFolder ? OBJECT_CHILD_TYPES[childFolder] : null;
    if (childType) {
      const leaf = parts[parts.length - 1];
      return { type: childType, name: `${objectName}.${stripSuffix(leaf)}`, metadata: true };
    }
    return { type: "CustomObject", name: objectName, metadata: true };
  }

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const type = DIRECTORY_TYPES[parts[index]];
    if (!type) continue;
    const child = parts[index + 1];
    if (!child) continue;

    // Bundles are addressed by their directory name, not by each file inside.
    if (type === "LightningComponentBundle" || type === "AuraDefinitionBundle" ||
        type === "StaticResource" || type === "Report" || type === "Dashboard" ||
        type === "EmailTemplate") {
      return { type, name: stripSuffix(child), metadata: true };
    }
    if (type === "CustomLabels") {
      return { type: "CustomLabels", name: "CustomLabels", metadata: true };
    }
    return { type, name: stripSuffix(parts[parts.length - 1]), metadata: true };
  }

  return { type: classifyNonMetadata(parts), name: filePath, metadata: false };
}

function classifyNonMetadata(parts) {
  const first = parts[0] ?? "";
  if (first === ".github") return "CI configuration";
  if (first === "tests" || first === "test") return "Test assets";
  if (first === "scripts") return "Scripts";
  if (first === "knowledge" || first === "docs") return "Documentation";
  if (first === ".claude") return "AI agent configuration";
  if (first === "manifest") return "Deployment manifest";
  return "Other";
}

/** Strip Salesforce compound suffixes: `Foo.cls-meta.xml` → `Foo`. */
function stripSuffix(fileName) {
  const dot = fileName.indexOf(".");
  return dot === -1 ? fileName : fileName.slice(0, dot);
}

/**
 * Read `git diff --name-status` for a range.
 *
 * @param {{base?: string, head?: string, cwd?: string}} options
 * @returns {{status: string, path: string}[]}
 */
export function readDiff({ base = "origin/main", head = "HEAD", cwd = process.cwd() } = {}) {
  const range = base ? `${base}...${head}` : head;
  const output = execFileSync("git", ["diff", "--name-status", range], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return parseNameStatus(output);
}

/** Parse `git diff --name-status` output (handles rename/copy records). */
export function parseNameStatus(output) {
  const entries = [];
  for (const line of String(output).split("\n")) {
    if (!line.trim()) continue;
    const columns = line.split("\t");
    const status = columns[0][0];
    // Renames and copies carry both old and new path; the new path is what shipped.
    const filePath = columns[columns.length - 1];
    if (filePath) entries.push({ status, path: filePath });
  }
  return entries;
}

/**
 * Collapse a diff into one entry per metadata component.
 *
 * @param {{status: string, path: string}[]} entries
 * @param {{includeNonMetadata?: boolean}} options
 * @returns {{components: object[], other: object[], counts: object}}
 */
export function deriveDeliverables(entries, { includeNonMetadata = true, packageDirs } = {}) {
  const dirs = packageDirs ?? readPackageDirectories();
  const components = new Map();
  const other = new Map();

  for (const entry of entries) {
    const classified = classifyPath(entry.path, dirs);
    const bucket = classified.metadata ? components : other;
    const key = `${classified.type}:${classified.name}`;
    const existing = bucket.get(key);
    const change = CHANGE_LABELS[entry.status] ?? "modified";

    if (!existing) {
      bucket.set(key, {
        type: classified.type,
        name: classified.name,
        change,
        files: [entry.path],
      });
      continue;
    }
    existing.files.push(entry.path);
    // A component whose files were both added and modified counts as modified;
    // only a uniformly added or deleted component keeps that label.
    if (existing.change !== change) existing.change = "modified";
  }

  const sortFn = (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name);
  const componentList = [...components.values()].sort(sortFn);
  const otherList = includeNonMetadata ? [...other.values()].sort(sortFn) : [];

  const counts = {};
  for (const component of componentList) {
    counts[component.type] = (counts[component.type] ?? 0) + 1;
  }

  return { components: componentList, other: otherList, counts };
}

/**
 * Render a Backlog-ready comment listing the ticket's deliverables.
 *
 * `context.format` selects the dialect: "markdown" (default) or "backlog" for a
 * project whose `textFormattingRule` is Backlog notation, where a Markdown table
 * would render as literal pipe characters.
 *
 * @param {{components: object[], other: object[], counts: object}} deliverables
 * @param {{ticket?: string, base?: string, head?: string, branch?: string,
 *          pull_request?: object, format?: "markdown"|"backlog"}} context
 */
export function renderMarkdown(deliverables, context = {}) {
  if (context.format === "backlog") return renderBacklogNotation(deliverables, context);
  const { components, other, counts } = deliverables;
  const lines = [];

  lines.push("## 成果物（メタデータ） / Delivered metadata");
  lines.push("");
  if (context.ticket) lines.push(`- 課題キー: ${context.ticket}`);
  if (context.branch) lines.push(`- ブランチ: \`${context.branch}\``);
  // A reviewer should be able to reach the code from the ticket in one click.
  if (context.pull_request?.url) {
    const pr = context.pull_request;
    const label = pr.number ? `PR #${pr.number}` : "PR";
    const state = pr.source === "compare" ? "未作成（比較リンク）" : pr.state;
    lines.push(`- ${label}: ${pr.url}${state ? ` （${state}）` : ""}`);
  }
  if (context.base) lines.push(`- 差分範囲: \`${context.base}...${context.head ?? "HEAD"}\``);
  lines.push(`- コンポーネント数: ${components.length}`);
  lines.push("");

  if (components.length === 0) {
    lines.push("_この差分に Salesforce メタデータの変更はありません。_");
  } else {
    lines.push("| 種別 (Type) | API 名 (Name) | 変更 (Change) |");
    lines.push("| --- | --- | --- |");
    for (const component of components) {
      lines.push(`| ${component.type} | \`${component.name}\` | ${component.change} |`);
    }
    lines.push("");
    lines.push("**種別ごとの件数:** " +
      Object.entries(counts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([type, count]) => `${type} ${count}`)
        .join(" / "));
  }

  if (other.length > 0) {
    lines.push("");
    lines.push("<details><summary>メタデータ以外の変更 (" + other.length + ")</summary>");
    lines.push("");
    for (const entry of other) {
      lines.push(`- ${entry.type}: \`${entry.name}\` (${entry.change})`);
    }
    lines.push("");
    lines.push("</details>");
  }

  return lines.join("\n") + "\n";
}

/**
 * Same content in Backlog notation, for projects not set to Markdown.
 *
 * Backlog notation uses `**` for headings, `|…|h` for a header row and `-` for
 * lists; a Markdown table would appear as raw pipes there.
 */
function renderBacklogNotation(deliverables, context = {}) {
  const { components, other, counts } = deliverables;
  const lines = ["** 成果物（メタデータ） / Delivered metadata", ""];

  if (context.ticket) lines.push(`- 課題キー: ${context.ticket}`);
  if (context.branch) lines.push(`- ブランチ: ${context.branch}`);
  if (context.pull_request?.url) {
    const pr = context.pull_request;
    const label = pr.number ? `PR #${pr.number}` : "PR";
    const state = pr.source === "compare" ? "未作成（比較リンク）" : pr.state;
    lines.push(`- ${label}: ${pr.url}${state ? ` （${state}）` : ""}`);
  }
  if (context.base) lines.push(`- 差分範囲: ${context.base}...${context.head ?? "HEAD"}`);
  lines.push(`- コンポーネント数: ${components.length}`);
  lines.push("");

  if (components.length === 0) {
    lines.push("この差分に Salesforce メタデータの変更はありません。");
  } else {
    lines.push("| 種別 (Type) | API 名 (Name) | 変更 (Change) |h");
    for (const component of components) {
      lines.push(`| ${component.type} | ${component.name} | ${component.change} |`);
    }
    lines.push("");
    lines.push(
      "種別ごとの件数: " +
        Object.entries(counts)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([type, count]) => `${type} ${count}`)
          .join(" / "),
    );
  }

  if (other.length > 0) {
    lines.push("");
    lines.push(`** メタデータ以外の変更 (${other.length})`);
    for (const entry of other) lines.push(`- ${entry.type}: ${entry.name} (${entry.change})`);
  }

  return lines.join("\n") + "\n";
}

/**
 * Emit a `package.xml` containing exactly this ticket's components.
 *
 * Deleted components are omitted: a deployment manifest cannot express a
 * deletion, which needs `destructiveChanges.xml` instead. The omission is
 * stated in a comment rather than passing silently.
 */
export function renderPackageXml(deliverables, { apiVersion = DEFAULT_API_VERSION } = {}) {
  const grouped = new Map();
  const deleted = [];

  for (const component of deliverables.components) {
    if (component.change === "deleted") {
      deleted.push(`${component.type} ${component.name}`);
      continue;
    }
    if (!grouped.has(component.type)) grouped.set(component.type, []);
    grouped.get(component.type).push(component.name);
  }

  const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
  lines.push('<Package xmlns="http://soap.sforce.com/2006/04/metadata">');
  if (deleted.length > 0) {
    lines.push(`    <!-- Deleted components are not deployable through package.xml;`);
    lines.push(`         add them to destructiveChanges.xml: ${deleted.join(", ")} -->`);
  }
  for (const type of [...grouped.keys()].sort()) {
    lines.push("    <types>");
    for (const member of grouped.get(type).sort()) {
      lines.push(`        <members>${escapeXml(member)}</members>`);
    }
    lines.push(`        <name>${type}</name>`);
    lines.push("    </types>");
  }
  lines.push(`    <version>${apiVersion}</version>`);
  lines.push("</Package>");
  return lines.join("\n") + "\n";
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Resolve the pull request for a branch.
 *
 * Uses `gh` when available, because it knows the authenticated host and the
 * default branch. Without `gh` (or before a PR exists) it falls back to a
 * compare URL built from the remote, so a reviewer still gets a link rather than
 * nothing. Never throws: a missing PR is normal before the PR is opened.
 *
 * @returns {{url: string, number: number|null, state: string, title: string,
 *            source: "gh"|"compare"|"none"}}
 */
export function resolvePullRequest({ cwd = process.cwd(), branch, base } = {}) {
  const head = branch || currentBranch(cwd);

  try {
    const raw = execFileSync(
      "gh",
      ["pr", "view", head, "--json", "url,number,state,title,baseRefName"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const data = JSON.parse(raw);
    if (data.url) {
      return {
        url: data.url,
        number: data.number ?? null,
        state: String(data.state ?? "").toLowerCase(),
        title: data.title ?? "",
        source: "gh",
      };
    }
  } catch {
    // No gh, not authenticated, or no PR for this branch yet.
  }

  const compare = compareUrl({ cwd, head, base });
  return compare
    ? { url: compare, number: null, state: "not opened", title: "", source: "compare" }
    : { url: "", number: null, state: "unknown", title: "", source: "none" };
}

/** A github.com compare URL for the branch, or "" when the remote is not GitHub. */
function compareUrl({ cwd, head, base }) {
  let remote = "";
  try {
    remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }

  const match = /github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
  if (!match || !head) return "";

  // A compare URL needs two refs GitHub can resolve. `--base` is often a git
  // revision (HEAD~2, a SHA) which is meaningful locally but not in a URL, so
  // anything that is not branch-like falls back to the remote's default branch.
  const requested = String(base ?? "").replace(/^origin\//, "");
  const branchLike = requested && !/[~^:]|^[0-9a-f]{7,40}$/i.test(requested);
  const target = branchLike ? requested : defaultBranch(cwd);

  return `https://github.com/${match[1]}/${match[2]}/compare/${target}...${encodeURIComponent(head)}?expand=1`;
}

/** The remote's default branch, falling back to main. */
function defaultBranch(cwd) {
  try {
    const ref = execFileSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const name = ref.replace(/^origin\//, "");
    if (name) return name;
  } catch {
    // No remote HEAD (a fresh clone with --single-branch, or no remote).
  }
  return "main";
}

/** Current branch name, or "" when git is unavailable. */
export function currentBranch(cwd = process.cwd()) {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}
