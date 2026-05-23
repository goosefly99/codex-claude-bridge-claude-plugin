/**
 * Delegator shape tests. These do NOT call the network; they verify input
 * validation, schema shape, and pattern dispatch routing.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

describe("delegator output schema", () => {
  const schemaPath = resolve(ROOT, "schemas", "delegator-output.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as {
    required?: string[];
    properties?: { status?: { enum?: string[] } };
    $defs?: {
      FileChange?: {
        required?: string[];
      };
    };
  };

  it("requires status, summary, files_changed, diff_stat, next_steps", () => {
    expect(schema.required).toEqual([
      "status",
      "summary",
      "files_changed",
      "diff_stat",
      "next_steps",
    ]);
  });

  it("status enum is completed | partial | error", () => {
    expect(schema.properties?.status?.enum).toEqual(["completed", "partial", "error"]);
  });

  it("file change record requires path, lines_added, lines_removed", () => {
    expect(schema.$defs?.FileChange?.required).toEqual([
      "path",
      "lines_added",
      "lines_removed",
    ]);
  });
});

describe("delegator argument validation", () => {
  it("delegate() rejects empty plan", async () => {
    const { delegate } = await import("../scripts/codex/delegator.js");
    await expect(delegate("")).rejects.toThrow(/non-empty/);
    await expect(delegate("   ")).rejects.toThrow(/non-empty/);
  });

  it("delegateParallel() rejects empty task list", async () => {
    const { delegateParallel } = await import("../scripts/codex/delegator.js");
    await expect(delegateParallel([])).rejects.toThrow(/non-empty/);
  });
});

describe("delegator system prompt", () => {
  const promptPath = resolve(ROOT, "prompts", "delegator-system.md");
  const prompt = readFileSync(promptPath, "utf-8");

  it("requires JSON envelope output", () => {
    expect(prompt).toMatch(/single valid JSON object/i);
  });

  it("requires forward-slash paths", () => {
    expect(prompt).toMatch(/forward-slash/i);
  });

  it("references the confirmation gate", () => {
    expect(prompt.toLowerCase()).toMatch(/confirmation gate/);
  });
});
