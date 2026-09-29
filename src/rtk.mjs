/**
 * rtk.mjs — rtk-sf integration, enabled by default.
 *
 * rtk-sf (https://github.com/furuCRM-Inc/rtk-sf) is the kit's default AI
 * companion: it indexes Salesforce metadata into compressed specs and serves
 * them over MCP, so an agent can read a class skeleton or an object schema
 * without pulling thousands of tokens of raw source into context. It also
 * generates the system document set this kit's `documentation` stage publishes.
 *
 * It stays *optional at runtime*: `ai_assist.rtk_sf.required` is false by
 * default, so a project without rtk-sf installed skips those stages with a
 * warning instead of failing. That keeps the kit usable in any SFDX project
 * while still integrating rtk-sf out of the box.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const RTK_REPO = "https://github.com/furuCRM-Inc/rtk-sf";
export const RTK_INSTALL_HINT =
  'pip install "git+https://github.com/furuCRM-Inc/rtk-sf.git@v0.10.0"';
export const RTK_MCP_HINT = "claude mcp add rtk-sf -- python3 -m rtk_sf serve";

/**
 * Probe for a usable rtk-sf installation.
 *
 * @param {{python?: string, cwd?: string}} options
 * @returns {{installed: boolean, version: string|null, python: string, detail: string}}
 */
export function detectRtkSf({ python = "python3", cwd = process.cwd() } = {}) {
  const probe = spawnSync(python, ["-m", "rtk_sf", "--version"], {
    cwd,
    encoding: "utf8",
    timeout: 20000,
  });

  if (probe.error) {
    return {
      installed: false,
      version: null,
      python,
      detail: `${python} could not be executed (${probe.error.code ?? probe.error.message})`,
    };
  }
  if (probe.status !== 0) {
    const stderr = (probe.stderr ?? "").trim().split("\n").pop() ?? "";
    return {
      installed: false,
      version: null,
      python,
      detail: stderr || `${python} -m rtk_sf exited ${probe.status}`,
    };
  }

  const output = `${probe.stdout ?? ""} ${probe.stderr ?? ""}`;
  const version = /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
  return {
    installed: true,
    version,
    python,
    detail: version ? `rtk-sf ${version}` : "rtk-sf installed (version not reported)",
  };
}

/** True when the project index exists, meaning rtk-sf has run here before. */
export function hasIndex(cwd = process.cwd()) {
  return existsSync(path.join(cwd, ".rtk-sf", "specs"));
}

/**
 * Decide what a stage requiring rtk-sf should do.
 *
 * @returns {{action: "run"|"skip"|"fail", message: string}}
 */
export function gateRtkSf(rtkConfig, detection) {
  if (!rtkConfig?.enabled) {
    return {
      action: "skip",
      message: "ai_assist.rtk_sf.enabled is false — skipping rtk-sf stages.",
    };
  }
  if (detection.installed) {
    return { action: "run", message: detection.detail };
  }
  if (rtkConfig.required) {
    return {
      action: "fail",
      message:
        `rtk-sf is required by this project (ai_assist.rtk_sf.required: true) but was not found: ` +
        `${detection.detail}. Install it with: ${RTK_INSTALL_HINT}`,
    };
  }
  return {
    action: "skip",
    message:
      `rtk-sf not found (${detection.detail}) — skipping. It is the recommended companion for ` +
      `AI-assisted Salesforce work; install with: ${RTK_INSTALL_HINT}`,
  };
}

/** Advice block printed by `init` and `doctor`. */
export function rtkAdvice(detection) {
  if (detection.installed) {
    return [
      `rtk-sf: ${detection.detail} — MCP registration: ${RTK_MCP_HINT}`,
      "  Index the project:  python3 -m rtk_sf index",
      "  Generate documents: python3 -m rtk_sf docs all --output-dir docs",
    ].join("\n");
  }
  return [
    `rtk-sf: not installed (${detection.detail}).`,
    "  This kit integrates rtk-sf by default for AI-assisted development:",
    "  compressed metadata specs over MCP, Apex skeletons instead of raw files,",
    "  and the generated system document set used by the `documentation` stage.",
    `  Install:  ${RTK_INSTALL_HINT}`,
    `  Register: ${RTK_MCP_HINT}`,
    "  Stages needing it are skipped (not failed) until then.",
  ].join("\n");
}
