/**
 * P4 integration test: delegateParallel() → two DelegationResults.
 *
 * Skipped unless CODEX_INTEGRATION=1 is set (requires a cached Codex token
 * and network access). Safe to run in CI for contributors without an OpenAI
 * account.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INTEGRATION = process.env["CODEX_INTEGRATION"] === "1";

describe.skipIf(!INTEGRATION)("P4 integration — delegateParallel() side-by-side", () => {
  let scratchDir: string;

  it(
    "delegateParallel([plan, plan]) returns two completed DelegationResults",
    async () => {
      scratchDir = mkdtempSync(join(tmpdir(), "codex-p4-"));

      const { execSync } = await import("node:child_process");
      execSync("git init", { cwd: scratchDir });
      execSync('git config user.email "test@codex-bridge"', { cwd: scratchDir });
      execSync('git config user.name "Codex Bridge Test"', { cwd: scratchDir });
      writeFileSync(join(scratchDir, "helpers.ts"), "export const add = (a: number, b: number) => a + b;\n");
      execSync("git add helpers.ts && git commit -m init", {
        cwd: scratchDir,
        shell: "/bin/bash",
      });

      const plan = [
        "Goal: add an exported multiply function to helpers.ts.",
        "Files to modify: helpers.ts",
        "Change: add 'export const multiply = (a: number, b: number) => a * b;' on a new line.",
        "Acceptance criteria: helpers.ts exports both add and multiply.",
        "Out of scope: tests, index files, other modules.",
      ].join("\n");

      process.chdir(scratchDir);
      const { delegateParallel } = await import("../scripts/codex/delegator.js");

      // P4 runs two independent agents on the same plan.
      // With isolate_worktrees: true each gets its own throwaway worktree.
      const results = await delegateParallel(
        [
          { plan, label: "agent-a" },
          { plan, label: "agent-b" },
        ],
        { isolate_worktrees: true, effort: "low" },
      );

      expect(results).toHaveLength(2);
      for (const result of results) {
        expect(["completed", "partial"]).toContain(result.status);
        expect(result.summary).toBeTruthy();
        expect(Array.isArray(result.next_steps)).toBe(true);
      }
    },
    120_000,
  );

  it.sequential("cleanup scratch dir", () => {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  });
});
