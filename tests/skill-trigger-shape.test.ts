/**
 * Skill-trigger-shape test.
 *
 * The `implement-with-codex` skill activates when Claude reads the user's
 * request and the SKILL.md description matches. The matching is fuzzy, but a
 * set of canonical phrases MUST appear verbatim so the skill activates
 * predictably on the patterns it's designed for.
 *
 * If a contributor "polishes" the description and drops a phrase, this test
 * fails — same protection as anti-drift.test.ts but for skill triggers.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

const CANONICAL_TRIGGERS = [
  "use codex to implement",
  "delegate this to codex",
  "have codex implement this then adversarial-review it",
  "run both Claude and codex on this",
  "split this work between Claude and codex",
  "ralph loop with codex as the reviewer",
] as const;

const CANONICAL_PATTERN_IDS = ["P1", "P3", "P4", "P5", "P7"] as const;

describe("implement-with-codex SKILL.md preserves canonical trigger phrases", () => {
  const skillPath = resolve(ROOT, "skills", "implement-with-codex", "SKILL.md");
  const skill = readFileSync(skillPath, "utf-8");

  for (const phrase of CANONICAL_TRIGGERS) {
    it(`description references the verbatim trigger phrase "${phrase}"`, () => {
      expect(skill.toLowerCase()).toContain(phrase.toLowerCase());
    });
  }

  for (const pid of CANONICAL_PATTERN_IDS) {
    it(`mentions pattern ${pid} verbatim`, () => {
      expect(skill).toContain(pid);
    });
  }

  it("references scripts/codex/delegator.ts (not transport.ts directly)", () => {
    expect(skill).toContain("scripts/codex/delegator.ts");
  });

  it("forbids direct transport.ts calls", () => {
    expect(skill.toLowerCase()).toMatch(/don't call transport\.ts directly/i);
  });

  it("requires no auto-commit", () => {
    expect(skill.toLowerCase()).toMatch(/don't auto-commit/i);
  });
});
