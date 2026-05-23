/**
 * Tests for the `agents-md-sync` skill: trigger phrases, lean-schema
 * template, and the `scripts/knowledge/agentsMd.ts` sync engine.
 *
 * All filesystem work happens in throwaway temp directories under
 * `os.tmpdir()`; the real project's AGENTS.md and CLAUDE.md are never
 * touched.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bootstrap,
  detect,
  mirrorToClaude,
  sectionDiff,
  parseSections,
} from "../scripts/knowledge/agentsMd.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

const CANONICAL_TRIGGERS = [
  "bootstrap AGENTS.md",
  "set up AGENTS.md for codex",
  "sync AGENTS.md with CLAUDE.md",
  "lean agents.md for this project",
  "make codex project context",
] as const;

const LEAN_SECTION_HEADINGS = [
  "User identity",
  "Project goal",
  "Style preferences",
  "Standing rules",
  "Known failure modes",
] as const;

function mkTemp(): string {
  return mkdtempSync(join(tmpdir(), "agents-md-sync-"));
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

describe("agents-md-sync SKILL.md preserves canonical trigger phrases", () => {
  const skillPath = resolve(ROOT, "skills", "agents-md-sync", "SKILL.md");
  const skill = readFileSync(skillPath, "utf-8");

  for (const phrase of CANONICAL_TRIGGERS) {
    it(`description references the verbatim trigger phrase "${phrase}"`, () => {
      expect(skill.toLowerCase()).toContain(phrase.toLowerCase());
    });
  }

  it("mentions AGENTS.md by name", () => {
    expect(skill).toContain("AGENTS.md");
  });

  it("mentions CLAUDE.md by name", () => {
    expect(skill).toContain("CLAUDE.md");
  });

  it("mentions the lean schema rule", () => {
    expect(skill.toLowerCase()).toContain("lean schema");
  });
});

describe("template.md contains the failure-as-knowledge managed-by marker", () => {
  const templatePath = resolve(ROOT, "skills", "agents-md-sync", "template.md");
  const template = readFileSync(templatePath, "utf-8");

  it("includes the managed-by: failure-as-knowledge marker", () => {
    expect(template).toContain("<!-- managed-by: failure-as-knowledge -->");
  });

  it("contains all 5 lean-schema sections", () => {
    for (const heading of LEAN_SECTION_HEADINGS) {
      expect(template).toContain(`## ${heading}`);
    }
  });
});

describe("agentsMd.detect", () => {
  it('returns "none" when neither file exists', async () => {
    const dir = mkTemp();
    try {
      const res = await detect({ cwd: dir });
      expect(res.state).toBe("none");
      expect(res.agents_sections).toEqual([]);
      expect(res.claude_sections).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  it('returns "agents_only" when AGENTS.md exists but CLAUDE.md does not', async () => {
    const dir = mkTemp();
    try {
      writeFileSync(
        join(dir, "AGENTS.md"),
        "# AGENTS.md\n\n## User identity\n\nA test user.\n",
      );
      const res = await detect({ cwd: dir });
      expect(res.state).toBe("agents_only");
      expect(res.agents_sections.length).toBeGreaterThan(0);
      expect(res.claude_sections).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  it('returns "claude_only" when CLAUDE.md exists but AGENTS.md does not', async () => {
    const dir = mkTemp();
    try {
      writeFileSync(
        join(dir, "CLAUDE.md"),
        "# CLAUDE.md\n\n## User identity\n\nA test user.\n",
      );
      const res = await detect({ cwd: dir });
      expect(res.state).toBe("claude_only");
      expect(res.claude_sections.length).toBeGreaterThan(0);
      expect(res.agents_sections).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  it('returns "both_present" when both exist and every section is identical', async () => {
    const dir = mkTemp();
    try {
      const body =
        "## User identity\n\nA test user.\n\n## Project goal\n\nShip it.\n";
      writeFileSync(join(dir, "AGENTS.md"), `# AGENTS.md\n\n${body}`);
      writeFileSync(join(dir, "CLAUDE.md"), `# CLAUDE.md\n\n${body}`);
      const res = await detect({ cwd: dir });
      expect(res.state).toBe("both_present");
    } finally {
      cleanup(dir);
    }
  });

  it('returns "both_diverged" when at least one section body differs', async () => {
    const dir = mkTemp();
    try {
      writeFileSync(
        join(dir, "AGENTS.md"),
        "# AGENTS.md\n\n## User identity\n\nAgents version.\n",
      );
      writeFileSync(
        join(dir, "CLAUDE.md"),
        "# CLAUDE.md\n\n## User identity\n\nClaude version differs.\n",
      );
      const res = await detect({ cwd: dir });
      expect(res.state).toBe("both_diverged");
    } finally {
      cleanup(dir);
    }
  });
});

describe("agentsMd.bootstrap", () => {
  it("creates AGENTS.md with all 5 lean-schema sections", async () => {
    const dir = mkTemp();
    try {
      const res = await bootstrap({ cwd: dir });
      expect(res.written).toBe(true);
      expect(existsSync(res.file)).toBe(true);
      const written = readFileSync(res.file, "utf-8");
      for (const heading of LEAN_SECTION_HEADINGS) {
        expect(written).toContain(`## ${heading}`);
      }
    } finally {
      cleanup(dir);
    }
  });

  it("is idempotent: second call without overwrite returns written:false and does not modify the file", async () => {
    const dir = mkTemp();
    try {
      const first = await bootstrap({ cwd: dir });
      expect(first.written).toBe(true);
      // Mutate the file so we can detect any unwanted rewrite.
      const target = join(dir, "AGENTS.md");
      writeFileSync(target, "# AGENTS.md\n\n## User identity\n\nuser tweaked this\n");
      const before = readFileSync(target, "utf-8");

      const second = await bootstrap({ cwd: dir });
      expect(second.written).toBe(false);
      const after = readFileSync(target, "utf-8");
      expect(after).toBe(before);
    } finally {
      cleanup(dir);
    }
  });

  it("overwrites when overwrite: true is passed", async () => {
    const dir = mkTemp();
    try {
      await bootstrap({ cwd: dir });
      const target = join(dir, "AGENTS.md");
      writeFileSync(target, "# AGENTS.md\n\n## User identity\n\nuser tweaked this\n");

      const res = await bootstrap({ cwd: dir, overwrite: true });
      expect(res.written).toBe(true);
      const after = readFileSync(target, "utf-8");
      expect(after).toContain("## Known failure modes");
    } finally {
      cleanup(dir);
    }
  });
});

describe("agentsMd.mirrorToClaude", () => {
  it("copies AGENTS.md content into CLAUDE.md", async () => {
    const dir = mkTemp();
    try {
      writeFileSync(
        join(dir, "AGENTS.md"),
        "# AGENTS.md\n\n## User identity\n\nThe operator.\n\n## Project goal\n\nShip a thing.\n",
      );
      const res = await mirrorToClaude({ cwd: dir });
      expect(res.written).toBe(true);
      const claude = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
      expect(claude).toContain("## User identity");
      expect(claude).toContain("The operator.");
      expect(claude).toContain("## Project goal");
      expect(claude).toContain("Ship a thing.");
    } finally {
      cleanup(dir);
    }
  });

  it("preserves an existing managed-by section in CLAUDE.md instead of overwriting it from AGENTS.md", async () => {
    const dir = mkTemp();
    try {
      // AGENTS.md has a Known failure modes section with content X.
      writeFileSync(
        join(dir, "AGENTS.md"),
        [
          "# AGENTS.md",
          "",
          "## User identity",
          "",
          "Operator.",
          "",
          "## Known failure modes",
          "<!-- managed-by: failure-as-knowledge -->",
          "",
          "FROM AGENTS - should not propagate",
          "",
        ].join("\n"),
      );

      // CLAUDE.md has a Known failure modes section with different content Y.
      const claudeManagedBody = [
        "# CLAUDE.md",
        "",
        "## User identity",
        "",
        "Operator.",
        "",
        "## Known failure modes",
        "<!-- managed-by: failure-as-knowledge -->",
        "",
        "FROM CLAUDE - must be preserved verbatim",
        "",
      ].join("\n");
      writeFileSync(join(dir, "CLAUDE.md"), claudeManagedBody);

      await mirrorToClaude({ cwd: dir });

      const claude = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
      expect(claude).toContain("FROM CLAUDE - must be preserved verbatim");
      expect(claude).not.toContain("FROM AGENTS - should not propagate");
    } finally {
      cleanup(dir);
    }
  });
});

describe("agentsMd.sectionDiff", () => {
  it("identifies a diverged section between AGENTS.md and CLAUDE.md", async () => {
    const dir = mkTemp();
    try {
      writeFileSync(
        join(dir, "AGENTS.md"),
        "# AGENTS.md\n\n## User identity\n\nAgents version.\n\n## Project goal\n\nShared.\n",
      );
      writeFileSync(
        join(dir, "CLAUDE.md"),
        "# CLAUDE.md\n\n## User identity\n\nDIFFERENT in Claude.\n\n## Project goal\n\nShared.\n",
      );
      const diff = await sectionDiff({ cwd: dir });
      const userIdentity = diff.find((d) => d.heading === "User identity");
      const projectGoal = diff.find((d) => d.heading === "Project goal");
      expect(userIdentity?.status).toBe("diverged");
      expect(projectGoal?.status).toBe("same");
    } finally {
      cleanup(dir);
    }
  });

  it("marks an AGENTS.md-only section as agents_only", async () => {
    const dir = mkTemp();
    try {
      writeFileSync(
        join(dir, "AGENTS.md"),
        "# AGENTS.md\n\n## User identity\n\nA.\n\n## Style preferences\n\nOnly in agents.\n",
      );
      writeFileSync(
        join(dir, "CLAUDE.md"),
        "# CLAUDE.md\n\n## User identity\n\nA.\n",
      );
      const diff = await sectionDiff({ cwd: dir });
      const stylePrefs = diff.find((d) => d.heading === "Style preferences");
      expect(stylePrefs?.status).toBe("agents_only");
    } finally {
      cleanup(dir);
    }
  });
});

describe("agentsMd.parseSections", () => {
  it("extracts level-2 sections and ignores level-1 title", () => {
    const md = [
      "# AGENTS.md",
      "",
      "Preamble paragraph.",
      "",
      "## User identity",
      "",
      "Operator description.",
      "",
      "## Project goal",
      "",
      "Build a thing.",
      "",
    ].join("\n");
    const sections = parseSections(md);
    expect(sections.length).toBe(2);
    expect(sections[0]?.heading).toBe("User identity");
    expect(sections[1]?.heading).toBe("Project goal");
  });

  it("records the managed_by marker on the section it appears in", () => {
    const md = [
      "## Known failure modes",
      "<!-- managed-by: failure-as-knowledge -->",
      "",
      "entries here",
      "",
    ].join("\n");
    const sections = parseSections(md);
    expect(sections[0]?.managed_by).toBe("failure-as-knowledge");
  });
});
