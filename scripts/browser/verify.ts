/**
 * Backend detection + report formatting for the `browser-verify` skill.
 *
 * This module does NOT execute any actual browser testing. It only:
 *   1. Probes the environment to figure out which external browser-driving
 *      backend is available (Playwright MCP, Codex Chrome plugin, or the
 *      `@browseruse` mention macro), and
 *   2. Formats a `VerificationReport` into a markdown punch list.
 *
 * The actual browser driving happens inside the Claude Code session via
 * whichever MCP backend is present. The skill manifest at
 * `skills/browser-verify/SKILL.md` tells Claude HOW to drive it; this module
 * is the small, testable helper that the skill calls.
 *
 * Detection rules are deliberately permissive — if a probe matches, we treat
 * the backend as available. The user can override by unsetting the env var.
 *
 * @module scripts/browser/verify
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { getLogger } from "../util/log.js";

const logger = getLogger("browserVerify");

/**
 * Identifier for a browser-driving backend.
 *
 * Preference order: `playwright-mcp` > `codex-chrome-plugin` > `browseruse-macro` > `none`.
 */
export type BrowserBackend =
  | "playwright-mcp"
  | "codex-chrome-plugin"
  | "browseruse-macro"
  | "none";

/**
 * Result of probing the environment for an available browser backend.
 */
export interface BackendDetection {
  /** Best available backend, in preference order. "none" means no backend is usable. */
  backend: BrowserBackend;
  /** Human-readable reason for the choice (or for the "none" verdict). */
  reason: string;
  /** Install instructions when `backend === "none"`. Empty array otherwise. */
  install_instructions: string[];
}

/**
 * A single observation from a browser verification pass.
 */
export interface VerificationFinding {
  /** How serious the finding is. */
  severity: "blocker" | "warning" | "ok";
  /** Short label identifying the UI surface (e.g. "header", "/dashboard route"). */
  surface: string;
  /** One-sentence description of what was observed. */
  description: string;
}

/**
 * Full report from a single verification pass.
 */
export interface VerificationReport {
  /** Which backend was used to drive the browser. */
  backend: BrowserBackend;
  /** The URL the verification targeted, if known. */
  target_url?: string;
  /** Findings collected during the verification. */
  findings: VerificationFinding[];
  /** Which named recipe was driven (see `playwright-recipes.md`). */
  recipe_used?: string;
}

/**
 * Resolve the `CLAUDE_PLUGIN_DATA` directory used for plugin-local config.
 * Falls back to `~/.claude/plugin-data` matching `scripts/util/log.ts`.
 */
function pluginDataDir(): string {
  const env = process.env["CLAUDE_PLUGIN_DATA"];
  if (env !== undefined && env.length > 0) return env;
  return join(homedir(), ".claude", "plugin-data");
}

/**
 * Test whether the Playwright MCP backend is available.
 *
 * Permissive: matches if the explicit env var is set OR if a config file
 * exists at `${CLAUDE_PLUGIN_DATA}/playwright-mcp.config`.
 */
function isPlaywrightMcpAvailable(): { ok: boolean; reason: string } {
  if (process.env["CLAUDE_MCP_PLAYWRIGHT"] === "1") {
    return { ok: true, reason: "CLAUDE_MCP_PLAYWRIGHT=1 in environment" };
  }
  const configPath = join(pluginDataDir(), "playwright-mcp.config");
  if (existsSync(configPath)) {
    return { ok: true, reason: `config file present at ${configPath}` };
  }
  return { ok: false, reason: "no Playwright MCP env var or config file found" };
}

/** Test whether the Codex Chrome plugin backend is available. */
function isCodexChromePluginAvailable(): { ok: boolean; reason: string } {
  if (process.env["CODEX_CHROME_PLUGIN"] === "1") {
    return { ok: true, reason: "CODEX_CHROME_PLUGIN=1 in environment" };
  }
  return { ok: false, reason: "CODEX_CHROME_PLUGIN env var not set" };
}

/** Test whether the `@browseruse` mention macro backend is available. */
function isBrowseruseAvailable(): { ok: boolean; reason: string } {
  if (process.env["BROWSERUSE_AVAILABLE"] === "1") {
    return { ok: true, reason: "BROWSERUSE_AVAILABLE=1 in environment" };
  }
  return { ok: false, reason: "BROWSERUSE_AVAILABLE env var not set" };
}

/**
 * Install instructions surfaced when no backend is available.
 *
 * Playwright MCP is the recommended path because it integrates cleanly with
 * Claude Code's MCP transport and does not require a credentialed browser
 * profile.
 */
const PLAYWRIGHT_INSTALL_INSTRUCTIONS: string[] = [
  "No browser-driving backend was detected. Install Playwright MCP (recommended) and rerun.",
  "1. Install Playwright MCP: `npm install -g @playwright/mcp` (or follow the official installer).",
  "2. Register the MCP server with Claude Code so it appears in the MCP list.",
  "3. Set CLAUDE_MCP_PLAYWRIGHT=1 in your shell, OR place a config file at ${CLAUDE_PLUGIN_DATA}/playwright-mcp.config (the file can be empty — its presence is the signal).",
  "4. Rerun the `browser-verify` skill.",
  "Alternative backends: the Codex Chrome plugin (set CODEX_CHROME_PLUGIN=1) or the `@browseruse` mention macro (set BROWSERUSE_AVAILABLE=1). Playwright MCP is preferred unless you have a specific reason to use one of the alternatives.",
];

/**
 * Probe the environment for an available browser-driving backend.
 *
 * Probes in preference order:
 *   1. Playwright MCP
 *   2. Codex Chrome plugin
 *   3. `@browseruse` mention macro
 *   4. None — returns install instructions for Playwright MCP.
 *
 * Filesystem/env-var probes only — never makes a network request.
 *
 * @returns The selected backend, a human-readable reason, and install
 *   instructions (empty unless `backend === "none"`).
 */
export async function detectBackend(): Promise<BackendDetection> {
  const playwright = isPlaywrightMcpAvailable();
  if (playwright.ok) {
    logger.info("backend selected", { backend: "playwright-mcp", reason: playwright.reason });
    return {
      backend: "playwright-mcp",
      reason: `Playwright MCP available: ${playwright.reason}`,
      install_instructions: [],
    };
  }

  const codexChrome = isCodexChromePluginAvailable();
  if (codexChrome.ok) {
    logger.info("backend selected", {
      backend: "codex-chrome-plugin",
      reason: codexChrome.reason,
    });
    return {
      backend: "codex-chrome-plugin",
      reason: `Codex Chrome plugin available: ${codexChrome.reason}`,
      install_instructions: [],
    };
  }

  const browseruse = isBrowseruseAvailable();
  if (browseruse.ok) {
    logger.info("backend selected", { backend: "browseruse-macro", reason: browseruse.reason });
    return {
      backend: "browseruse-macro",
      reason: `@browseruse macro available: ${browseruse.reason}`,
      install_instructions: [],
    };
  }

  logger.warn("no browser backend available", {
    playwright_reason: playwright.reason,
    codex_chrome_reason: codexChrome.reason,
    browseruse_reason: browseruse.reason,
  });

  return {
    backend: "none",
    reason:
      "No browser-driving backend detected. Probed Playwright MCP, Codex Chrome plugin, and @browseruse macro.",
    install_instructions: PLAYWRIGHT_INSTALL_INSTRUCTIONS,
  };
}

/** Severity ordering used when grouping findings in `formatReport`. */
const SEVERITY_ORDER: ReadonlyArray<VerificationFinding["severity"]> = [
  "blocker",
  "warning",
  "ok",
];

/** Map severity to the bracketed label shown in the report. */
const SEVERITY_LABEL: Record<VerificationFinding["severity"], string> = {
  blocker: "[BLOCKER]",
  warning: "[WARN]",
  ok: "[OK]",
};

/**
 * Render a `VerificationReport` to a markdown string the skill can show.
 *
 * Findings are grouped by severity in the order [BLOCKER] > [WARN] > [OK].
 * Labels are emoji-free for terminal-safe display.
 *
 * @param report The verification report to format.
 * @returns A markdown-formatted string suitable for printing in a session.
 */
export function formatReport(report: VerificationReport): string {
  const lines: string[] = [];
  lines.push("# Browser-Verify Report");
  lines.push("");
  lines.push(`Backend: \`${report.backend}\``);
  if (report.target_url !== undefined && report.target_url.length > 0) {
    lines.push(`Target URL: ${report.target_url}`);
  }
  if (report.recipe_used !== undefined && report.recipe_used.length > 0) {
    lines.push(`Recipe: \`${report.recipe_used}\``);
  }
  lines.push("");

  if (report.findings.length === 0) {
    lines.push("No findings recorded.");
    return lines.join("\n");
  }

  for (const severity of SEVERITY_ORDER) {
    const subset = report.findings.filter((f) => f.severity === severity);
    if (subset.length === 0) continue;

    lines.push(`## ${SEVERITY_LABEL[severity]} (${subset.length})`);
    for (const finding of subset) {
      lines.push(`- ${SEVERITY_LABEL[severity]} \`${finding.surface}\` — ${finding.description}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
