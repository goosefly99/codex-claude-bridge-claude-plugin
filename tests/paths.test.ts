/**
 * Path normalization tests (DI-9). Critical that these pass on Windows CI.
 */

import { describe, expect, it } from "vitest";

import { normalize, toUnixPath, isWithin } from "../scripts/util/paths.js";

describe("paths.normalize", () => {
  it("converts a relative path to absolute", () => {
    const out = normalize("./README.md");
    expect(out.length).toBeGreaterThan("README.md".length);
  });

  it("rejects empty input", () => {
    expect(() => normalize("")).toThrow(/non-empty/);
  });

  it("rejects null bytes", () => {
    const nb = String.fromCharCode(0);
    expect(() => normalize(`bad${nb}path`)).toThrow(/null byte/);
  });
});

describe("paths.toUnixPath", () => {
  it("does not contain backslashes for ordinary paths", () => {
    const out = toUnixPath("./README.md");
    expect(out).not.toContain("\\");
  });

  it("preserves forward-slash form for UNC inputs", () => {
    const out = toUnixPath("\\\\server\\share\\path");
    expect(out).toMatch(/^\/\/server\/share\/path/);
  });
});

describe("paths.isWithin", () => {
  it("returns true when child is inside parent", () => {
    expect(isWithin(".", "./README.md")).toBe(true);
  });

  it("returns false when child escapes via ..", () => {
    expect(isWithin("./subdir", "..")).toBe(false);
  });
});
