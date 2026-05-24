/**
 * Filesystem context collector for the general-purpose review commands
 * (/codex:review and /codex:adversarial-review on arbitrary paths).
 *
 * Diff-scoped reviews use git plumbing; general reviews need to walk files and
 * folders the user names and assemble their contents into a prompt under the
 * shared `context_token_budget`. This module is the single place that does
 * that walk, applies ignore rules, and caps the result.
 *
 * Returned shape includes `truncated` and `skipped` so the calling engine can
 * tell the model (and the user) exactly what was omitted.
 *
 * @module scripts/codex/fsContext
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

import { getConfig } from "../util/config.js";
import { getLogger } from "../util/log.js";

const log = getLogger("fsContext");

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".bz2",
  ".7z",
  ".rar",
  ".mp3",
  ".mp4",
  ".mov",
  ".avi",
  ".webm",
  ".wav",
  ".flac",
  ".ogg",
  ".otf",
  ".ttf",
  ".woff",
  ".woff2",
  ".eot",
  ".so",
  ".dylib",
  ".dll",
  ".exe",
  ".bin",
  ".o",
  ".a",
  ".class",
  ".jar",
  ".pyc",
  ".node",
  ".wasm",
]);

const FALLBACK_IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".acv",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".nuxt",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "target",
]);

const MAX_FILE_BYTES_DEFAULT = 256 * 1024;

function toRelUnix(rel: string): string {
  return rel.replace(/\\/g, "/");
}

export interface CollectOptions {
  /** Override config.context_token_budget for tests / explicit caller cap. */
  tokenBudget?: number;
  /** Override the per-file byte cap. Files larger than this are skipped. */
  maxFileBytes?: number;
  /** Override the resolution root (defaults to process.cwd()). For tests. */
  root?: string;
}

export interface CollectedFile {
  relPath: string;
  content: string;
}

export interface CollectedContext {
  files: CollectedFile[];
  totalTokens: number;
  truncated: boolean;
  skipped: string[];
}

function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function isGitRepo(root: string): boolean {
  const res = spawnSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf-8",
  });
  return res.status === 0 && (res.stdout ?? "").trim() === "true";
}

function gitFilterIgnored(root: string, paths: string[]): Set<string> {
  if (paths.length === 0) return new Set();
  const res = spawnSync(
    "git",
    ["-C", root, "check-ignore", "--stdin", "-z"],
    { input: paths.join("\0"), encoding: "utf-8" },
  );
  if (res.status !== 0 && res.status !== 1) {
    log.warn("git check-ignore failed; falling back to deny-list only", {
      status: res.status,
      stderr: res.stderr,
    });
    return new Set();
  }
  const out = (res.stdout ?? "").split("\0").filter(Boolean);
  return new Set(out);
}

function isFallbackIgnoredSegment(segment: string): boolean {
  return FALLBACK_IGNORE_DIRS.has(segment) || segment.startsWith(".");
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

function ensureInsideRoot(root: string, target: string): string {
  const resolved = resolve(root, target);
  const rel = relative(root, resolved);
  if (rel.startsWith("..")) {
    throw new Error(
      `path "${target}" resolves outside the working directory; refusing to read`,
    );
  }
  return resolved;
}

function walk(start: string, out: string[], fallbackOnly: boolean): void {
  let stat;
  try {
    stat = statSync(start);
  } catch (err) {
    log.warn("path does not exist; skipping", { start, err: String(err) });
    return;
  }
  if (stat.isFile()) {
    out.push(start);
    return;
  }
  if (!stat.isDirectory()) return;

  let entries;
  try {
    entries = readdirSync(start, { withFileTypes: true });
  } catch (err) {
    log.warn("readdir failed; skipping", { start, err: String(err) });
    return;
  }
  for (const e of entries) {
    if (fallbackOnly && isFallbackIgnoredSegment(e.name)) continue;
    if (!fallbackOnly && FALLBACK_IGNORE_DIRS.has(e.name)) continue;
    const child = join(start, e.name);
    if (e.isDirectory()) {
      walk(child, out, fallbackOnly);
    } else if (e.isFile()) {
      out.push(child);
    }
  }
}

/**
 * Walk the given paths (files or folders), respecting ignore rules and the
 * shared token budget. Paths must resolve inside the configured root (default:
 * process.cwd()); paths that escape are rejected to keep the surface small.
 */
export async function collectFilesystemContext(
  inputs: string[],
  opts: CollectOptions = {},
): Promise<CollectedContext> {
  if (inputs.length === 0) {
    throw new Error("collectFilesystemContext requires at least one path");
  }
  const root = resolve(opts.root ?? process.cwd());
  const cfg = await getConfig();
  const tokenBudget = opts.tokenBudget ?? cfg.context_token_budget;
  const maxFileBytes = opts.maxFileBytes ?? MAX_FILE_BYTES_DEFAULT;
  const useGitIgnore = isGitRepo(root);

  const resolved: string[] = [];
  for (const input of inputs) {
    const abs = ensureInsideRoot(root, input);
    if (!existsSync(abs)) {
      throw new Error(`path not found: ${input}`);
    }
    walk(abs, resolved, !useGitIgnore);
  }

  const deduped = Array.from(new Set(resolved));
  const relPaths = deduped.map((p) => relative(root, p));
  const gitIgnored = useGitIgnore ? gitFilterIgnored(root, relPaths) : new Set<string>();

  const files: CollectedFile[] = [];
  const skipped: string[] = [];
  let totalTokens = 0;
  let truncated = false;

  const candidates = deduped.map((abs, i) => ({ abs, rel: relPaths[i] ?? abs }));
  candidates.sort((a, b) => a.rel.localeCompare(b.rel));

  for (const { abs, rel } of candidates) {
    if (gitIgnored.has(rel)) {
      skipped.push(`${toRelUnix(rel)} (gitignored)`);
      continue;
    }
    if (BINARY_EXTENSIONS.has(extname(rel).toLowerCase())) {
      skipped.push(`${toRelUnix(rel)} (binary extension)`);
      continue;
    }
    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch (err) {
      skipped.push(`${toRelUnix(rel)} (unreadable: ${String(err)})`);
      continue;
    }
    if (buf.length > maxFileBytes) {
      skipped.push(`${toRelUnix(rel)} (file > ${maxFileBytes} bytes)`);
      continue;
    }
    if (looksBinary(buf)) {
      skipped.push(`${toRelUnix(rel)} (binary content)`);
      continue;
    }
    const content = buf.toString("utf-8");
    const tok = approximateTokens(content);
    if (totalTokens + tok > tokenBudget) {
      truncated = true;
      skipped.push(`${toRelUnix(rel)} (token budget exhausted)`);
      continue;
    }
    files.push({ relPath: toRelUnix(rel), content });
    totalTokens += tok;
  }

  return { files, totalTokens, truncated, skipped };
}
