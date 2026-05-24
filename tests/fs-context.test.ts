/**
 * Tests for the filesystem-context collector used by the general-purpose
 * review commands (/codex:review and /codex:adversarial-review).
 *
 * Covers:
 *   - single file input
 *   - directory walk
 *   - fallback deny-list when outside a git repo
 *   - binary detection (extension + null-byte sniff)
 *   - per-file byte cap
 *   - token-budget exhaustion surfacing as `truncated: true`
 *   - refusal to read paths that resolve outside the configured root
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectFilesystemContext } from "../scripts/codex/fsContext.js";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "fs-context-test-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe("collectFilesystemContext", () => {
  it("rejects empty input list", async () => {
    await expect(collectFilesystemContext([], { root: workdir })).rejects.toThrow(
      /at least one path/,
    );
  });

  it("reads a single file relative to the configured root", async () => {
    writeFileSync(join(workdir, "hello.txt"), "hi");
    const ctx = await collectFilesystemContext(["hello.txt"], { root: workdir });
    expect(ctx.files).toHaveLength(1);
    expect(ctx.files[0]?.relPath).toBe("hello.txt");
    expect(ctx.files[0]?.content).toBe("hi");
    expect(ctx.truncated).toBe(false);
  });

  it("walks a directory and includes every readable file", async () => {
    mkdirSync(join(workdir, "src"));
    writeFileSync(join(workdir, "src", "a.ts"), "export const a = 1;");
    writeFileSync(join(workdir, "src", "b.ts"), "export const b = 2;");
    const ctx = await collectFilesystemContext(["src"], { root: workdir });
    const rels = ctx.files.map((f) => f.relPath).sort();
    expect(rels).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("applies the fallback deny-list when outside a git repo", async () => {
    mkdirSync(join(workdir, "node_modules", "foo"), { recursive: true });
    writeFileSync(join(workdir, "node_modules", "foo", "index.js"), "junk");
    writeFileSync(join(workdir, "real.ts"), "export {};");
    const ctx = await collectFilesystemContext(["."], { root: workdir });
    const rels = ctx.files.map((f) => f.relPath);
    expect(rels).toContain("real.ts");
    expect(rels.some((p) => p.startsWith("node_modules/"))).toBe(false);
  });

  it("skips binary files by extension", async () => {
    writeFileSync(join(workdir, "logo.png"), "not-actually-png");
    writeFileSync(join(workdir, "data.txt"), "plain text");
    const ctx = await collectFilesystemContext(["."], { root: workdir });
    expect(ctx.files.map((f) => f.relPath)).toEqual(["data.txt"]);
    expect(ctx.skipped.some((s) => s.includes("logo.png") && s.includes("binary"))).toBe(true);
  });

  it("skips files that contain null bytes (binary content)", async () => {
    writeFileSync(join(workdir, "weird"), Buffer.from([0x68, 0x00, 0x69]));
    writeFileSync(join(workdir, "clean"), "text");
    const ctx = await collectFilesystemContext(["."], { root: workdir });
    expect(ctx.files.map((f) => f.relPath)).toEqual(["clean"]);
    expect(ctx.skipped.some((s) => s.includes("weird") && s.includes("binary"))).toBe(true);
  });

  it("skips files larger than the per-file byte cap", async () => {
    writeFileSync(join(workdir, "big.txt"), "x".repeat(2048));
    writeFileSync(join(workdir, "small.txt"), "ok");
    const ctx = await collectFilesystemContext(["."], {
      root: workdir,
      maxFileBytes: 1024,
    });
    expect(ctx.files.map((f) => f.relPath)).toEqual(["small.txt"]);
    expect(ctx.skipped.some((s) => s.includes("big.txt") && s.includes("bytes"))).toBe(true);
  });

  it("marks truncated=true and skips remaining files when the token budget is exhausted", async () => {
    writeFileSync(join(workdir, "a.txt"), "a".repeat(400));
    writeFileSync(join(workdir, "b.txt"), "b".repeat(400));
    writeFileSync(join(workdir, "c.txt"), "c".repeat(400));
    const ctx = await collectFilesystemContext(["."], {
      root: workdir,
      tokenBudget: 150,
    });
    expect(ctx.truncated).toBe(true);
    expect(ctx.files.length).toBeLessThan(3);
    expect(ctx.skipped.some((s) => s.includes("token budget"))).toBe(true);
  });

  it("refuses paths that resolve outside the configured root", async () => {
    await expect(
      collectFilesystemContext(["../etc/passwd"], { root: workdir }),
    ).rejects.toThrow(/outside the working directory/);
  });

  it("throws when a path does not exist", async () => {
    await expect(
      collectFilesystemContext(["nope.txt"], { root: workdir }),
    ).rejects.toThrow(/path not found/);
  });

  it("dedupes when the same file is given via both file and parent-directory input", async () => {
    writeFileSync(join(workdir, "only.txt"), "x");
    const ctx = await collectFilesystemContext([".", "only.txt"], { root: workdir });
    expect(ctx.files.filter((f) => f.relPath === "only.txt")).toHaveLength(1);
  });
});
