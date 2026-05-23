/**
 * P1 integration test: delegate() → DelegationResult with status "completed".
 *
 * Skipped unless CODEX_INTEGRATION=1 is set (requires a cached Codex token
 * and network access). Safe to run in CI contributors without an OpenAI
 * account.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INTEGRATION = process.env["CODEX_INTEGRATION"] === "1";

describe.skipIf(!INTEGRATION)("P1 integration — delegate() basic round-trip", () => {
  let scratchDir: string;

  it(
    "delegate() with a trivial plan returns DelegationResult with status completed",
    async () => {
      scratchDir = mkdtempSync(join(tmpdir(), "codex-p1-"));

      // Create a minimal scratch repo so git state is valid.
      const { execSync } = await import("node:child_process");
      execSync("git init", { cwd: scratchDir });
      execSync('git config user.email "test@codex-bridge"', { cwd: scratchDir });
      execSync('git config user.name "Codex Bridge Test"', { cwd: scratchDir });
      writeFileSync(join(scratchDir, "README.md"), "# scratch\n");
      execSync("git add README.md && git commit -m init", {
        cwd: scratchDir,
        shell: "/bin/bash",
      });

      const plan = [
        "Goal: append a one-line comment to README.md.",
        "Files to modify: README.md",
        "Change: add '<!-- codex-bridge integration test -->' at the end of the file.",
        "Acceptance criteria: the final line of README.md matches the comment above.",
        "Out of scope: everything else.",
      ].join("\n");

      process.chdir(scratchDir);
      const { delegate } = await import("../scripts/codex/delegator.js");
      const result = await delegate(plan, { effort: "low" });

      expect(result.status).toBe("completed");
      expect(result.summary).toBeTruthy();
      expect(Array.isArray(result.next_steps)).toBe(true);
    },
    60_000,
  );

  // cleanup
  it.sequential("cleanup scratch dir", () => {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  });
});
