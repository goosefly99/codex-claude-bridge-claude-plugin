/**
 * Unit tests for the detached background spawn mechanism.
 *
 * Verifies that a detached child process survives the parent's exit and
 * writes its result to the expected location. Uses a tiny child script
 * rather than calling the real Codex transport.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";

import {
  spawnDetached,
  writeJobResult,
  readUndeliveredResults,
  markResultDelivered,
} from "../scripts/concurrency/jobManager.js";

const testDir = join(tmpdir(), "codex-bridge-test-" + process.pid);

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  delete process.env["CLAUDE_PLUGIN_DATA"];
});

describe("spawnDetached", () => {
  it("returns without waiting for the child to finish", async () => {
    mkdirSync(testDir, { recursive: true });
    const jobId = "test-job-" + Date.now();
    const marker = join(testDir, "done.txt");

    // Spawn a child that sleeps 200ms then writes a marker file.
    const childScript = [
      "const { writeFileSync } = require('fs');",
      `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'done'), 200);`,
    ].join(" ");

    const start = Date.now();
    spawnDetached(jobId, process.execPath, ["-e", childScript]);
    const elapsed = Date.now() - start;

    // spawnDetached should return in well under 100ms even though the child takes 200ms.
    expect(elapsed).toBeLessThan(100);

    // The child should eventually write the marker file.
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    expect(existsSync(marker)).toBe(true);
  });

  it("passes extraEnv to the child", async () => {
    mkdirSync(testDir, { recursive: true });
    const jobId = "test-env-" + Date.now();
    const markerPath = join(testDir, "env.txt");
    const sentinel = "HELLO_FROM_CHILD";

    const childScript = [
      "const { writeFileSync } = require('fs');",
      `writeFileSync(${JSON.stringify(markerPath)}, process.env.MY_TEST_VAR ?? 'missing');`,
    ].join(" ");

    spawnDetached(jobId, process.execPath, ["-e", childScript], { MY_TEST_VAR: sentinel });

    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf-8")).toBe(sentinel);
  });
});

describe("readUndeliveredResults / markResultDelivered", () => {
  it("returns empty array when results dir does not exist", () => {
    process.env["CLAUDE_PLUGIN_DATA"] = testDir;
    const results = readUndeliveredResults();
    expect(results).toEqual([]);
  });

  it("surfaces written results and hides them after delivery", () => {
    const data = join(testDir, "data");
    mkdirSync(join(data, "codex-bridge", "results"), { recursive: true });
    process.env["CLAUDE_PLUGIN_DATA"] = data;

    const jobId = "result-test-" + Date.now();
    writeJobResult(jobId, "codex:adversarial-review", { verdict: "pass" });

    const first = readUndeliveredResults();
    expect(first.length).toBe(1);
    expect(first[0]?.jobId).toBe(jobId);

    markResultDelivered(jobId);

    const second = readUndeliveredResults();
    expect(second.length).toBe(0);
  });
});
