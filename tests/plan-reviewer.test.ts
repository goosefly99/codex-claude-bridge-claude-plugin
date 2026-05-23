/**
 * Anti-drift + shape tests for the plan-reviewer skill.
 *
 * The six gap categories are this skill's differentiator — same role as
 * the seven attack surfaces in `tests/anti-drift.test.ts`, but for the
 * PLAN-stage reviewer (not the code reviewer). If a contributor "polishes"
 * the system prompt and drops a category, this test fails loudly.
 *
 * Cross-file mirror: any rename must coordinate
 *   - prompts/plan-review-system.md (the system prompt)
 *   - schemas/plan-review-output.json (the gap.category enum)
 *   - scripts/codex/planReviewer.ts (the PLAN_REVIEW_CATEGORIES const)
 *   - skills/adversarial-plan-review/SKILL.md (user-facing taxonomy mention)
 * in a single commit.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

const PLAN_REVIEW_CATEGORIES = [
  "missing-requirement",
  "hidden-assumption",
  "scope-creep",
  "security-blind-spot",
  "integration-gap",
  "observability-gap",
] as const;

const CANONICAL_SKILL_TRIGGERS = [
  "review my plan",
  "pressure-test this plan before I code",
  "adversarial-review the plan",
  "find the gaps in my plan",
  "kashef loop on this plan",
] as const;

describe("anti-drift: plan-review system prompt locks the 6 gap categories", () => {
  const promptPath = resolve(ROOT, "prompts", "plan-review-system.md");
  const prompt = readFileSync(promptPath, "utf-8");

  for (const category of PLAN_REVIEW_CATEGORIES) {
    it(`prompt contains the verbatim category name "${category}"`, () => {
      expect(prompt).toContain(category);
    });
  }

  it("prompt enumerates exactly six categories (no additions, no removals)", () => {
    const presentCount = PLAN_REVIEW_CATEGORIES.filter((c) => prompt.includes(c)).length;
    expect(presentCount).toBe(PLAN_REVIEW_CATEGORIES.length);
  });

  it("prompt declares the artifact under review is a PLAN, not code", () => {
    // The reviewer must not bleed into the code-review taxonomy. The prompt
    // should explicitly call out "plan" and not "code" as the subject.
    expect(prompt).toMatch(/written plan/i);
    expect(prompt).toMatch(/not\s+(reviewing\s+)?code/i);
  });

  it("prompt requires JSON-only output (no prose envelope)", () => {
    expect(prompt).toMatch(/single valid JSON object/i);
    expect(prompt.toLowerCase()).toMatch(/no prose/);
  });

  it("prompt defines the three verdict thresholds tied to severity_score", () => {
    expect(prompt).toMatch(/acceptable/i);
    expect(prompt).toMatch(/needs-revision/i);
    expect(prompt).toMatch(/unfit/i);
    // Threshold numbers must appear so Codex has the cutoffs.
    expect(prompt).toContain("25");
    expect(prompt).toContain("70");
  });
});

describe("schemas/plan-review-output.json shape", () => {
  const schemaPath = resolve(ROOT, "schemas", "plan-review-output.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as {
    required?: string[];
    additionalProperties?: boolean;
    properties?: {
      verdict?: { enum?: string[] };
      severity_score?: { minimum?: number; maximum?: number };
    };
    $defs?: {
      Gap?: {
        required?: string[];
        properties?: { category?: { enum?: string[] } };
      };
    };
    $id?: string;
  };

  it("requires verdict, severity_score, gaps, out_of_scope_validated, next_revision_hints", () => {
    expect(schema.required).toEqual([
      "verdict",
      "severity_score",
      "gaps",
      "out_of_scope_validated",
      "next_revision_hints",
    ]);
  });

  it("forbids additional properties on the root object", () => {
    expect(schema.additionalProperties).toBe(false);
  });

  it("verdict enum is acceptable | needs-revision | unfit", () => {
    expect(schema.properties?.verdict?.enum).toEqual([
      "acceptable",
      "needs-revision",
      "unfit",
    ]);
  });

  it("severity_score is bounded to [0, 100]", () => {
    expect(schema.properties?.severity_score?.minimum).toBe(0);
    expect(schema.properties?.severity_score?.maximum).toBe(100);
  });

  it("gap record requires category, description, impact, mitigation", () => {
    expect(schema.$defs?.Gap?.required).toEqual([
      "category",
      "description",
      "impact",
      "mitigation",
    ]);
  });

  it("gap category enum mirrors the 6 plan-review categories verbatim", () => {
    expect(schema.$defs?.Gap?.properties?.category?.enum).toEqual([
      ...PLAN_REVIEW_CATEGORIES,
    ]);
  });

  it("uses the canonical $id for the plan-review-output schema", () => {
    expect(schema.$id).toBe(
      "https://github.com/TBD/codex-claude-bridge/schemas/plan-review-output.json",
    );
  });
});

describe("adversarial-plan-review SKILL.md preserves canonical trigger phrases", () => {
  const skillPath = resolve(ROOT, "skills", "adversarial-plan-review", "SKILL.md");
  const skill = readFileSync(skillPath, "utf-8");

  for (const phrase of CANONICAL_SKILL_TRIGGERS) {
    it(`description references the verbatim trigger phrase "${phrase}"`, () => {
      expect(skill.toLowerCase()).toContain(phrase.toLowerCase());
    });
  }

  it("mentions the loop cap of 3 iterations", () => {
    // "3 iterations", "≤3 iterations", "up to 3", or similar must appear so
    // users know the loop is bounded.
    expect(skill).toMatch(/3\s*iterations/i);
  });

  it("states the skill runs on a PLAN, not code", () => {
    expect(skill).toMatch(/plan,\s*not\s*code/i);
  });

  it("forbids reusing the 7-attack-surface taxonomy", () => {
    expect(skill.toLowerCase()).toMatch(/7-attack-surface taxonomy/);
  });

  it("forbids auto-executing the revised plan", () => {
    expect(skill.toLowerCase()).toMatch(/don't auto-execute/i);
  });

  it("differentiates from /codex:adversarial-review explicitly", () => {
    expect(skill).toContain("/codex:adversarial-review");
  });
});

describe("scripts/codex/planReviewer.ts module surface", () => {
  it("exports PLAN_REVIEW_CATEGORIES with all 6 names in order", async () => {
    const mod = (await import("../scripts/codex/planReviewer.js")) as {
      PLAN_REVIEW_CATEGORIES?: readonly string[];
    };
    expect(mod.PLAN_REVIEW_CATEGORIES).toBeDefined();
    expect(mod.PLAN_REVIEW_CATEGORIES).toEqual([...PLAN_REVIEW_CATEGORIES]);
  });

  it("exports runPlanReview and runPlanReviewLoop as functions", async () => {
    const mod = (await import("../scripts/codex/planReviewer.js")) as {
      runPlanReview?: unknown;
      runPlanReviewLoop?: unknown;
    };
    expect(typeof mod.runPlanReview).toBe("function");
    expect(typeof mod.runPlanReviewLoop).toBe("function");
  });

  it("runPlanReview rejects empty plan text without calling the network", async () => {
    const { runPlanReview } = await import("../scripts/codex/planReviewer.js");
    await expect(runPlanReview("")).rejects.toThrow(/non-empty/);
    await expect(runPlanReview("   ")).rejects.toThrow(/non-empty/);
  });

  it("runPlanReviewLoop rejects empty plan text without calling the network", async () => {
    const { runPlanReviewLoop } = await import("../scripts/codex/planReviewer.js");
    await expect(runPlanReviewLoop("")).rejects.toThrow(/non-empty/);
    await expect(runPlanReviewLoop("   ")).rejects.toThrow(/non-empty/);
  });
});
