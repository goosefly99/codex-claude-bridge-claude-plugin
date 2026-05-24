/**
 * Engine-level tests for the general-purpose review entry points.
 *
 * The CLIs (cli-review.ts, cli-adversarial-review.ts) are thin wrappers that
 * exit 5 when no paths are supplied. Below that surface, the engine functions
 * themselves throw informative errors so background-spawned jobs and direct
 * callers (skills, tests) see the same failure mode.
 */

import { describe, expect, it } from "vitest";

import {
  runGeneralReview,
  runGeneralAdversarialReview,
} from "../scripts/codex/adversarialEngine.js";

describe("runGeneralReview / runGeneralAdversarialReview empty-paths guard", () => {
  it("runGeneralReview rejects empty paths array with a hint to /codex:diff-review", async () => {
    await expect(runGeneralReview([])).rejects.toThrow(
      /requires at least one path.*runDiffReview.*codex:diff-review/i,
    );
  });

  it("runGeneralAdversarialReview rejects empty paths array with a hint to /codex:adversarial-diff-review", async () => {
    await expect(runGeneralAdversarialReview([])).rejects.toThrow(
      /requires at least one path.*runAdversarialDiffReview.*codex:adversarial-diff-review/i,
    );
  });

  it("runGeneralAdversarialReview rejects an unknown --focus surface", async () => {
    type OptsT = Parameters<typeof runGeneralAdversarialReview>[1];
    const badOpts = { focus: "not-a-surface" } as unknown as OptsT;
    await expect(
      runGeneralAdversarialReview(["package.json"], badOpts),
    ).rejects.toThrow(/unknown --focus surface/);
  });
});
