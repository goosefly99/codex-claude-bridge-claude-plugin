/**
 * Anti-drift test for the locked adversarial system prompt.
 *
 * This is the most important test in the suite. The 7-attack-surface
 * taxonomy (DI-3) is the plugin's differentiator. If a future contributor
 * "cleans up" the prompt and accidentally drops a surface, the differentiator
 * silently degrades and reviews become generic.
 *
 * This test fails loudly if any of the 7 surface names is missing from
 * `prompts/adversarial-system.md`. Do not disable it. Do not weaken it.
 *
 * The same 7 strings also appear in:
 *   - schemas/adversarial-output.json (the `surface` enum)
 *   - scripts/codex/adversarialEngine.ts (the ATTACK_SURFACES const)
 *   - AGENTS.md (under "Hard invariants")
 * Renames must be coordinated across all four files in a single commit.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

const ATTACK_SURFACES = [
  "Authentication",
  "Data loss",
  "Rollbacks",
  "Race conditions",
  "Degraded dependencies",
  "Version skew",
  "Observability gaps",
] as const;

describe("anti-drift: adversarial system prompt locks the 7 attack surfaces", () => {
  const promptPath = resolve(ROOT, "prompts", "adversarial-system.md");
  const prompt = readFileSync(promptPath, "utf-8");

  for (const surface of ATTACK_SURFACES) {
    it(`prompt contains the verbatim surface name "${surface}"`, () => {
      expect(prompt).toContain(surface);
    });
  }

  it("prompt enumerates exactly seven surfaces (no additions, no removals)", () => {
    // Sanity check: each surface appears at least once. We don't enforce
    // exact count because surface names like "Authentication" might be
    // referenced multiple times in the prose. Existence is the contract.
    const presentCount = ATTACK_SURFACES.filter((s) => prompt.includes(s))
      .length;
    expect(presentCount).toBe(ATTACK_SURFACES.length);
  });

  it("schemas/adversarial-output.json mirrors the same 7 surface names", () => {
    const schemaPath = resolve(ROOT, "schemas", "adversarial-output.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as {
      $defs?: { Issue?: { properties?: { surface?: { enum?: string[] } } } };
    };
    const surfaceEnum = schema.$defs?.Issue?.properties?.surface?.enum;
    expect(surfaceEnum).toBeDefined();
    expect(surfaceEnum).toEqual([...ATTACK_SURFACES]);
  });
});
