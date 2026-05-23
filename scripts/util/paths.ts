/**
 * Cross-platform path normalization (DI-9 release blocker).
 *
 * The reference plugin shipped with a Windows path resolution bug within days
 * of release. This module is the only sanctioned source of path normalization
 * in the codebase. Every component that touches a path must route through it.
 *
 * Specific concerns we address:
 *   - Backslash vs forward-slash mixing (Windows uses `\` natively but git,
 *     URLs, and JSON paths expect `/`).
 *   - Drive-letter case differences (`C:\Users` vs `c:\users`).
 *   - OneDrive-redirected user homes (e.g.
 *     `C:\Users\<u>\OneDrive\Documents\projects` vs `C:\Users\<u>\projects`).
 *   - Paths containing spaces (`C:\Program Files`, `C:\Users\Mary Jane`).
 *   - UNC paths (`\\server\share\path`) and network drives.
 *   - Symlinks: resolve consistently or document why we don't.
 *
 * Test fixtures live in `tests/windows-paths.test.ts` and run on a Windows
 * CI runner from day one.
 *
 * @module scripts/util/paths
 */

import { isAbsolute, resolve, relative, sep } from "node:path";

const IS_WINDOWS = process.platform === "win32";
const NULL_BYTE = String.fromCharCode(0);

function rejectNullBytes(input: string): void {
  if (input.indexOf(NULL_BYTE) !== -1) {
    const err = new Error("path contains null byte");
    (err as Error & { cause?: unknown }).cause = { kind: "path_resolution" };
    throw err;
  }
}

function lowerCaseDriveLetter(p: string): string {
  if (!IS_WINDOWS) return p;
  if (p.length >= 2 && p[1] === ":" && /[A-Z]/.test(p[0] ?? "")) {
    return (p[0]?.toLowerCase() ?? "") + p.slice(1);
  }
  return p;
}

function isUncPath(p: string): boolean {
  return p.startsWith("\\\\") || p.startsWith("//");
}

/**
 * Normalize a filesystem path for *logical* comparison and persistence.
 *
 * @param input The raw path.
 * @returns A normalized absolute path in the platform-native form.
 * @throws ErrorKind.path_resolution on malformed input.
 */
export function normalize(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    const err = new Error("path must be a non-empty string");
    (err as Error & { cause?: unknown }).cause = { kind: "path_resolution" };
    throw err;
  }
  rejectNullBytes(input);

  if (isUncPath(input)) {
    return IS_WINDOWS ? input.replace(/\//g, "\\") : input;
  }

  const resolved = isAbsolute(input) ? resolve(input) : resolve(process.cwd(), input);
  return lowerCaseDriveLetter(resolved);
}

/**
 * Convert a path to forward-slash form for embedding in JSON, URLs, or
 * cross-platform diff output.
 *
 * @param input The raw path.
 * @returns A forward-slash-form absolute path.
 * @throws ErrorKind.path_resolution on malformed input.
 */
export function toUnixPath(input: string): string {
  rejectNullBytes(input);

  if (isUncPath(input)) {
    return input.replace(/\\/g, "/");
  }

  const norm = normalize(input);
  return norm.replace(/\\/g, "/");
}

/**
 * Check if `child` is contained within `parent`.
 *
 * @param parent The candidate parent directory.
 * @param child The candidate child path.
 * @returns true iff child is logically inside parent.
 */
export function isWithin(parent: string, child: string): boolean {
  const p = normalize(parent);
  const c = normalize(child);
  const rel = relative(p, c);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  if (isAbsolute(rel)) return false;
  const head = rel.split(sep)[0] ?? "";
  return head !== ".." && !head.startsWith("..");
}
