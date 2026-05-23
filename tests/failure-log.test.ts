/**
 * Tests for `scripts/knowledge/failureLog.ts` and the `failure-as-knowledge`
 * SKILL.md trigger phrases.
 *
 * All file-system tests use a fresh temp directory under `os.tmpdir()` —
 * we never write to the actual project AGENTS.md / CLAUDE.md.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  appendFailure,
  listFailures,
  symptomHash,
  type FailureEntry,
} from "../scripts/knowledge/failureLog.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

const CANONICAL_TRIGGERS = [
  "log this error",
  "remember this for next time",
  "add this to AGENTS.md so we don't repeat it",
  "capture this failure",
  "note this so we don't hit it again",
] as const;

describe("failure-as-knowledge SKILL.md preserves canonical trigger phrases", () => {
  const skillPath = resolve(ROOT, "skills", "failure-as-knowledge", "SKILL.md");
  const skill = readFileSync(skillPath, "utf-8");

  for (const phrase of CANONICAL_TRIGGERS) {
    it(`description references the verbatim trigger phrase "${phrase}"`, () => {
      expect(skill).toContain(phrase);
    });
  }

  it("mentions AGENTS.md by name", () => {
    expect(skill).toContain("AGENTS.md");
  });

  it("mentions CLAUDE.md by name", () => {
    expect(skill).toContain("CLAUDE.md");
  });

  it("mentions the dedupe behavior in the description", () => {
    // The frontmatter description block is the first part of the file.
    const frontmatter = skill.split("---")[1] ?? "";
    expect(frontmatter.toLowerCase()).toMatch(/dedup/);
  });

  it("declares allowed_tools without Grep", () => {
    expect(skill).toContain('allowed_tools: ["Bash", "Read", "Write", "Edit"]');
  });
});

describe("failureLog.appendFailure", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "failure-log-test-"));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("creates AGENTS.md with the section header and a single entry when absent", async () => {
    const entry: FailureEntry = {
      symptom: "TypeError on undefined.foo",
      root_cause: "Object was nullable but consumer assumed initialized.",
      prevention: "Use exhaustive guard before property access.",
      date: "2026-05-22",
    };
    const results = await appendFailure(entry, { cwd: workdir });

    expect(results).toHaveLength(1);
    expect(results[0]?.deduplicated).toBe(false);
    expect(results[0]?.total_entries).toBe(1);

    const agentsPath = join(workdir, "AGENTS.md");
    const content = readFileSync(agentsPath, "utf-8");
    expect(content).toContain("## Known failure modes");
    expect(content).toContain("<!-- managed-by: failure-as-knowledge -->");
    expect(content).toContain("### 2026-05-22 — TypeError on undefined.foo");
    expect(content).toContain("- Root cause: Object was nullable");
    expect(content).toContain("- Prevention: Use exhaustive guard");
    expect(content).toContain(`<!-- failure-id: ${symptomHash(entry.symptom)} -->`);
  });

  it("appends a second entry above the first (reverse-chronological)", async () => {
    const first: FailureEntry = {
      symptom: "First failure",
      root_cause: "Cause one.",
      prevention: "Rule one.",
      date: "2026-05-20",
    };
    const second: FailureEntry = {
      symptom: "Second failure",
      root_cause: "Cause two.",
      prevention: "Rule two.",
      date: "2026-05-22",
    };
    await appendFailure(first, { cwd: workdir });
    await appendFailure(second, { cwd: workdir });

    const content = readFileSync(join(workdir, "AGENTS.md"), "utf-8");
    const idxSecond = content.indexOf("Second failure");
    const idxFirst = content.indexOf("First failure");
    expect(idxSecond).toBeGreaterThan(-1);
    expect(idxFirst).toBeGreaterThan(-1);
    expect(idxSecond).toBeLessThan(idxFirst);
  });

  it("dedupes a repeat append by symptom hash and leaves file content unchanged", async () => {
    const entry: FailureEntry = {
      symptom: "Race condition under load",
      root_cause: "Two writers updated the cache without a lock.",
      prevention: "Wrap the cache update in a mutex.",
      date: "2026-05-22",
    };
    const first = await appendFailure(entry, { cwd: workdir });
    expect(first[0]?.deduplicated).toBe(false);

    const agentsPath = join(workdir, "AGENTS.md");
    const beforeContent = readFileSync(agentsPath, "utf-8");

    const second = await appendFailure(entry, { cwd: workdir });
    expect(second[0]?.deduplicated).toBe(true);
    expect(second[0]?.total_entries).toBe(1);

    const afterContent = readFileSync(agentsPath, "utf-8");
    expect(afterContent).toBe(beforeContent);
  });

  it("dedupes case- and whitespace-insensitively on the symptom", async () => {
    await appendFailure(
      {
        symptom: "Race Condition Under Load",
        root_cause: "x",
        prevention: "y",
        date: "2026-05-22",
      },
      { cwd: workdir },
    );
    const repeat = await appendFailure(
      {
        symptom: "  race condition under load  ",
        root_cause: "different cause",
        prevention: "different rule",
        date: "2026-05-23",
      },
      { cwd: workdir },
    );
    expect(repeat[0]?.deduplicated).toBe(true);
  });

  it("mirrors to CLAUDE.md when it exists", async () => {
    const claudePath = join(workdir, "CLAUDE.md");
    writeFileSync(claudePath, "# CLAUDE.md\n\nProject memory.\n", "utf-8");

    const results = await appendFailure(
      {
        symptom: "Flaky test in CI",
        root_cause: "Network call without retry.",
        prevention: "Add fetch retry with backoff.",
        date: "2026-05-22",
      },
      { cwd: workdir },
    );

    expect(results).toHaveLength(2);
    const files = results.map((r) => r.file);
    expect(files.some((f) => f.endsWith("AGENTS.md"))).toBe(true);
    expect(files.some((f) => f.endsWith("CLAUDE.md"))).toBe(true);

    const claudeContent = readFileSync(claudePath, "utf-8");
    expect(claudeContent).toContain("# CLAUDE.md");
    expect(claudeContent).toContain("## Known failure modes");
    expect(claudeContent).toContain("Flaky test in CI");
  });

  it("does not create CLAUDE.md when it is absent", async () => {
    await appendFailure(
      {
        symptom: "Missing claude mirror target",
        root_cause: "Test scenario.",
        prevention: "Test scenario.",
        date: "2026-05-22",
      },
      { cwd: workdir },
    );

    expect(existsSync(join(workdir, "CLAUDE.md"))).toBe(false);
  });

  it("respects mirror_to_claude_md: false even when CLAUDE.md exists", async () => {
    const claudePath = join(workdir, "CLAUDE.md");
    writeFileSync(claudePath, "# CLAUDE.md\n", "utf-8");

    const results = await appendFailure(
      {
        symptom: "No mirror",
        root_cause: "x",
        prevention: "y",
        date: "2026-05-22",
      },
      { cwd: workdir, mirror_to_claude_md: false },
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.file.endsWith("AGENTS.md")).toBe(true);
    const claudeContent = readFileSync(claudePath, "utf-8");
    expect(claudeContent).not.toContain("## Known failure modes");
  });

  it("sanitizes token/secret values in symptom and root_cause", async () => {
    await appendFailure(
      {
        symptom: "Login broke with token=secret123abc456def in the URL",
        root_cause:
          "Token logged because authorization=Bearer xyz789 leaked into stack trace.",
        prevention: "Redact bearer values before logging.",
        date: "2026-05-22",
      },
      { cwd: workdir },
    );

    const content = readFileSync(join(workdir, "AGENTS.md"), "utf-8");
    expect(content).toContain("token=[redacted]");
    expect(content).not.toContain("secret123abc456def");
    expect(content).not.toContain("xyz789");
  });

  it("does not redact innocuous words like 'credentialing'", async () => {
    await appendFailure(
      {
        symptom: "Credentialing flow surfaced a UI glitch",
        root_cause: "Modal closed mid-render during credentialing.",
        prevention: "Defer modal close until render commit.",
        date: "2026-05-22",
      },
      { cwd: workdir },
    );
    const content = readFileSync(join(workdir, "AGENTS.md"), "utf-8");
    expect(content).toContain("Credentialing flow");
    expect(content).toContain("during credentialing.");
  });

  it("includes related_files when provided", async () => {
    await appendFailure(
      {
        symptom: "Build failed on Windows",
        root_cause: "Backslash leak in path concat.",
        prevention: "Always route through paths.toUnixPath.",
        related_files: ["scripts/util/paths.ts", "tests/paths.test.ts"],
        date: "2026-05-22",
      },
      { cwd: workdir },
    );
    const content = readFileSync(join(workdir, "AGENTS.md"), "utf-8");
    expect(content).toContain(
      "- Related: scripts/util/paths.ts, tests/paths.test.ts",
    );
  });

  it("preserves pre-existing file content outside the managed section", async () => {
    const agentsPath = join(workdir, "AGENTS.md");
    const pre =
      "# AGENTS.md\n\nLoad-bearing prose.\n\n## Hard invariants\n\n- Never log tokens.\n";
    writeFileSync(agentsPath, pre, "utf-8");

    await appendFailure(
      {
        symptom: "Idempotency check",
        root_cause: "Need to verify pre-existing prose survives.",
        prevention: "Section writer must be append-only.",
        date: "2026-05-22",
      },
      { cwd: workdir },
    );

    const content = readFileSync(agentsPath, "utf-8");
    expect(content.startsWith("# AGENTS.md\n\nLoad-bearing prose.")).toBe(true);
    expect(content).toContain("## Hard invariants");
    expect(content).toContain("- Never log tokens.");
    expect(content).toContain("## Known failure modes");
    expect(content).toContain("Idempotency check");
  });

  it("rejects an empty symptom", async () => {
    await expect(
      appendFailure(
        { symptom: "", root_cause: "x", prevention: "y" },
        { cwd: workdir },
      ),
    ).rejects.toThrow(/symptom/);
  });

  it("rejects writes outside the supplied cwd", async () => {
    const inner = mkdtempSync(join(workdir, "inner-"));
    const outer = workdir;
    // Trying to use the outer dir's AGENTS.md while claiming `inner` as
    // cwd — by passing an absolute file path to listFailures that escapes.
    await expect(
      listFailures({ cwd: inner, file: join(outer, "AGENTS.md") }),
    ).rejects.toThrow(/outside workspace/);
  });
});

describe("failureLog.listFailures", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "failure-log-test-"));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("returns an empty array when AGENTS.md is absent", async () => {
    const out = await listFailures({ cwd: workdir });
    expect(out).toEqual([]);
  });

  it("round-trips two entries in reverse-chronological order", async () => {
    await appendFailure(
      {
        symptom: "First failure",
        root_cause: "Cause one.",
        prevention: "Rule one.",
        date: "2026-05-20",
      },
      { cwd: workdir },
    );
    await appendFailure(
      {
        symptom: "Second failure",
        root_cause: "Cause two.",
        prevention: "Rule two.",
        date: "2026-05-22",
        related_files: ["a.ts", "b.ts"],
      },
      { cwd: workdir },
    );

    const out = await listFailures({ cwd: workdir });
    expect(out).toHaveLength(2);
    expect(out[0]?.symptom).toBe("Second failure");
    expect(out[0]?.related_files).toEqual(["a.ts", "b.ts"]);
    expect(out[1]?.symptom).toBe("First failure");
  });
});

describe("failureLog.symptomHash", () => {
  it("is stable for the same symptom", () => {
    expect(symptomHash("Race condition under load")).toBe(
      symptomHash("Race condition under load"),
    );
  });

  it("is case- and whitespace-insensitive", () => {
    expect(symptomHash("Race condition under load")).toBe(
      symptomHash("  RACE Condition Under Load  "),
    );
  });

  it("differs across distinct symptoms", () => {
    expect(symptomHash("Race condition")).not.toBe(symptomHash("Auth failure"));
  });

  it("is 8 lowercase hex characters", () => {
    expect(symptomHash("anything")).toMatch(/^[0-9a-f]{8}$/);
  });
});
