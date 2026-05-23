/**
 * Trigger-shape and contract tests for the `browser-verify` skill.
 *
 * Mirrors `skill-trigger-shape.test.ts`: a set of canonical phrases must
 * appear VERBATIM in the skill manifest so the skill activates predictably
 * on the patterns it's designed for. Additionally exercises the small
 * detection + formatting helpers exported from `scripts/browser/verify.ts`.
 *
 * No network calls.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  detectBackend,
  formatReport,
  type VerificationReport,
} from "../scripts/browser/verify.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

const CANONICAL_TRIGGERS = [
  "verify the UI",
  "click through this",
  "browser-test the change",
  "did my UI changes work",
  "smoke-test the dashboard",
] as const;

const CANONICAL_BACKENDS = ["Playwright MCP", "@browseruse", "Codex Chrome plugin"] as const;

const CANONICAL_RECIPES = [
  "smoke-routes",
  "primary-cta-clickthrough",
  "form-roundtrip",
  "dark-mode-toggle",
  "network-failure-degradation",
] as const;

describe("browser-verify SKILL.md preserves canonical trigger phrases", () => {
  const skillPath = resolve(ROOT, "skills", "browser-verify", "SKILL.md");
  const skill = readFileSync(skillPath, "utf-8");

  for (const phrase of CANONICAL_TRIGGERS) {
    it(`description references the verbatim trigger phrase "${phrase}"`, () => {
      expect(skill.toLowerCase()).toContain(phrase.toLowerCase());
    });
  }

  for (const backend of CANONICAL_BACKENDS) {
    it(`mentions backend "${backend}" verbatim`, () => {
      expect(skill).toContain(backend);
    });
  }

  it("is declared read-only via allowed_tools (no Write or Edit)", () => {
    expect(skill).toContain('allowed_tools: ["Bash", "Read", "Grep"]');
  });

  it("forbids modifying code from inside the skill", () => {
    expect(skill.toLowerCase()).toMatch(/don't modify code in this skill/i);
  });

  it("forbids auto-fixing bugs found", () => {
    expect(skill.toLowerCase()).toMatch(/don't auto-fix bugs found/i);
  });
});

describe("browser-verify playwright-recipes.md lists the canonical recipes", () => {
  const recipesPath = resolve(ROOT, "skills", "browser-verify", "playwright-recipes.md");
  const recipes = readFileSync(recipesPath, "utf-8");

  for (const recipe of CANONICAL_RECIPES) {
    it(`contains the recipe "${recipe}" verbatim`, () => {
      expect(recipes).toContain(recipe);
    });
  }
});

describe("detectBackend probes env vars and config files", () => {
  const SAVED_ENV: Record<string, string | undefined> = {};
  const KEYS = [
    "CLAUDE_MCP_PLAYWRIGHT",
    "CODEX_CHROME_PLUGIN",
    "BROWSERUSE_AVAILABLE",
    "CLAUDE_PLUGIN_DATA",
  ] as const;

  beforeEach(() => {
    for (const k of KEYS) {
      SAVED_ENV[k] = process.env[k];
      delete process.env[k];
    }
    // Point CLAUDE_PLUGIN_DATA at a path that definitely has no config file,
    // so the Playwright MCP probe cannot accidentally match a leftover file
    // in the real plugin-data dir on the test machine.
    process.env["CLAUDE_PLUGIN_DATA"] = resolve(ROOT, "tests", "__nonexistent_plugin_data__");
  });

  afterEach(() => {
    for (const k of KEYS) {
      const saved = SAVED_ENV[k];
      if (saved === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved;
      }
    }
  });

  it("returns 'none' with non-empty install instructions when no probes match", async () => {
    const result = await detectBackend();
    expect(result.backend).toBe("none");
    expect(result.install_instructions.length).toBeGreaterThan(0);
    expect(result.install_instructions.join("\n").toLowerCase()).toContain("playwright");
  });

  it("selects 'playwright-mcp' when CLAUDE_MCP_PLAYWRIGHT=1", async () => {
    process.env["CLAUDE_MCP_PLAYWRIGHT"] = "1";
    const result = await detectBackend();
    expect(result.backend).toBe("playwright-mcp");
    expect(result.install_instructions).toEqual([]);
  });

  it("selects 'codex-chrome-plugin' when only CODEX_CHROME_PLUGIN=1", async () => {
    process.env["CODEX_CHROME_PLUGIN"] = "1";
    const result = await detectBackend();
    expect(result.backend).toBe("codex-chrome-plugin");
  });

  it("selects 'browseruse-macro' when only BROWSERUSE_AVAILABLE=1", async () => {
    process.env["BROWSERUSE_AVAILABLE"] = "1";
    const result = await detectBackend();
    expect(result.backend).toBe("browseruse-macro");
  });

  it("prefers Playwright MCP over Codex Chrome when both are set", async () => {
    process.env["CLAUDE_MCP_PLAYWRIGHT"] = "1";
    process.env["CODEX_CHROME_PLUGIN"] = "1";
    const result = await detectBackend();
    expect(result.backend).toBe("playwright-mcp");
  });
});

describe("formatReport groups findings by severity with bracketed labels", () => {
  it("includes [BLOCKER], [WARN], and [OK] labels when each severity is present", () => {
    const report: VerificationReport = {
      backend: "playwright-mcp",
      target_url: "http://localhost:3000",
      recipe_used: "smoke-routes",
      findings: [
        { severity: "blocker", surface: "/dashboard", description: "page crashed on load" },
        { severity: "warning", surface: "header", description: "logo is misaligned" },
        { severity: "ok", surface: "/about", description: "renders cleanly" },
      ],
    };

    const out = formatReport(report);
    expect(out).toContain("[BLOCKER]");
    expect(out).toContain("[WARN]");
    expect(out).toContain("[OK]");
    expect(out).toContain("playwright-mcp");
    expect(out).toContain("smoke-routes");
    expect(out).toContain("http://localhost:3000");
  });

  it("emits a 'no findings' line when the findings array is empty", () => {
    const report: VerificationReport = {
      backend: "playwright-mcp",
      findings: [],
    };
    const out = formatReport(report);
    expect(out).toMatch(/no findings/i);
  });

  it("orders [BLOCKER] before [WARN] before [OK] in the output", () => {
    const report: VerificationReport = {
      backend: "playwright-mcp",
      findings: [
        { severity: "ok", surface: "a", description: "fine" },
        { severity: "warning", surface: "b", description: "minor" },
        { severity: "blocker", surface: "c", description: "broken" },
      ],
    };
    const out = formatReport(report);
    const idxBlocker = out.indexOf("[BLOCKER]");
    const idxWarn = out.indexOf("[WARN]");
    const idxOk = out.indexOf("[OK]");
    expect(idxBlocker).toBeGreaterThanOrEqual(0);
    expect(idxWarn).toBeGreaterThan(idxBlocker);
    expect(idxOk).toBeGreaterThan(idxWarn);
  });

  it("does not contain emojis (terminal-safe labels only)", () => {
    const report: VerificationReport = {
      backend: "playwright-mcp",
      findings: [{ severity: "blocker", surface: "x", description: "y" }],
    };
    const out = formatReport(report);
    // Emoji range U+1F300-U+1FAFF, plus common symbols.
    expect(out).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});
