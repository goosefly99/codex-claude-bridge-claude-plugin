/**
 * Failure-as-knowledge log writer.
 *
 * Persists structured failure entries to `AGENTS.md` (and optionally mirrors
 * to `CLAUDE.md`) so each debugging session converts into permanent project
 * knowledge. Entries live under a dedicated `## Known failure modes` section
 * and are de-duplicated by a short hash of the symptom so the same error
 * doesn't get appended twice.
 *
 * Hard rules:
 *   - Never writes outside the supplied cwd. All write targets are validated
 *     with `scripts/util/paths.ts.isWithin` before touching disk.
 *   - Sanitizes text fields for token/secret/bearer/api-key/password
 *     substrings (using the same `REDACT_KEY_PATTERN` semantics as
 *     `scripts/util/log.ts`) unless `skip_sanitization: true` is passed.
 *   - Append-only on the underlying file. Existing prose is preserved
 *     verbatim. The section header is created idempotently if missing.
 *   - Reverse-chronological: the newest entry sits directly under the
 *     section header.
 *
 * @module scripts/knowledge/failureLog
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { getLogger } from "../util/log.js";
import { isWithin } from "../util/paths.js";

const log = getLogger("failureLog");

/** Section header used inside AGENTS.md / CLAUDE.md. */
const SECTION_HEADER = "## Known failure modes";

/** Provenance marker so future tooling can find the managed section. */
const PROVENANCE_MARKER = "<!-- managed-by: failure-as-knowledge -->";

/**
 * Substring patterns that should never be persisted in clear text.
 *
 * Mirrors the keyword set in `scripts/util/log.ts.REDACT_KEY_PATTERN` but
 * applied as substring matches against value bodies, not object keys. We
 * deliberately scope each match to the trailing token/value so innocuous
 * words like "credentialing" are not damaged.
 */
const REDACT_SUBSTRING_PATTERNS: ReadonlyArray<RegExp> = [
  /token[:=\s]+\S+/gi,
  /secret[:=\s]+\S+/gi,
  /bearer\s+\S+/gi,
  /api[_-]?key[:=\s]+\S+/gi,
  /authorization[:=\s]+\S+/gi,
  /password[:=\s]+\S+/gi,
  /credential[:=\s]+\S+/gi,
];

/** Replacement text used in place of a redacted substring. */
const REDACTED_TOKEN = "[redacted]";

/** A single failure entry. */
export interface FailureEntry {
  /** 1-line description of the observed failure. */
  symptom: string;
  /** 1-2 lines explaining why it happened. */
  root_cause: string;
  /** 1-line rule that prevents recurrence. */
  prevention: string;
  /** Optional related forward-slash file paths. */
  related_files?: string[];
  /** ISO date YYYY-MM-DD; defaults to today (UTC) if omitted. */
  date?: string;
}

/** Caller-supplied options for {@link appendFailure}. */
export interface AppendOptions {
  /** Root directory; defaults to `process.cwd()`. */
  cwd?: string;
  /** If true and CLAUDE.md exists in cwd, mirror the entry to it too. Default: true. */
  mirror_to_claude_md?: boolean;
  /** Skip secret sanitization (NOT recommended). Default: false. */
  skip_sanitization?: boolean;
}

/** Result of a single {@link appendFailure} write to one file. */
export interface AppendResult {
  /** Path of the file the entry was written to. */
  file: string;
  /** True if the entry was deduplicated (existing entry matched by symptom hash). */
  deduplicated: boolean;
  /** Total entries in the file after the operation. */
  total_entries: number;
}

/** Internal parsed representation of a single block under the section. */
interface ParsedBlock {
  hash: string;
  raw: string;
  entry: FailureEntry;
}

/**
 * Sanitize a single text field by replacing token/secret/etc. substrings
 * with `[redacted]`. Conservative — only matches `keyword[:=\s]+VALUE` so
 * harmless prose stays intact.
 *
 * @param input The text to sanitize.
 * @returns The sanitized text. Never throws.
 */
function sanitize(input: string): string {
  let out = input;
  for (const pat of REDACT_SUBSTRING_PATTERNS) {
    out = out.replace(pat, (m) => {
      // Preserve the leading keyword and the assigning separator, replace
      // only the value portion. e.g. "token=abc123" -> "token=[redacted]".
      const sepMatch = m.match(/^(\S+?)([:=\s]+)/);
      if (sepMatch) {
        return `${sepMatch[1]}${sepMatch[2]}${REDACTED_TOKEN}`;
      }
      return REDACTED_TOKEN;
    });
  }
  return out;
}

/**
 * Sanitize all text fields of a {@link FailureEntry}. Returns a new object.
 *
 * @param entry The entry to sanitize.
 * @returns A new entry with sensitive substrings redacted.
 */
function sanitizeEntry(entry: FailureEntry): FailureEntry {
  const out: FailureEntry = {
    symptom: sanitize(entry.symptom),
    root_cause: sanitize(entry.root_cause),
    prevention: sanitize(entry.prevention),
  };
  if (entry.date !== undefined) {
    out.date = entry.date;
  }
  if (entry.related_files !== undefined) {
    out.related_files = entry.related_files.map((p) => sanitize(p));
  }
  return out;
}

/** Compute the today date in UTC as `YYYY-MM-DD`. */
function todayUtc(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Compute a short stable hash for a symptom string.
 *
 * Uses SHA-1 over the lowercased, trimmed symptom and keeps the first 8 hex
 * characters. Collision probability for any realistic project's failure log
 * is negligible. The hash is what `## Known failure modes` uses for
 * idempotent dedupe.
 *
 * @param symptom The 1-line symptom text.
 * @returns 8-char lowercase hex string.
 */
export function symptomHash(symptom: string): string {
  return createHash("sha1")
    .update(symptom.trim().toLowerCase())
    .digest("hex")
    .slice(0, 8);
}

/**
 * Render a single entry as its on-disk Markdown block (without the leading
 * `<!-- failure-id: ... -->` marker — that is prepended by the writer).
 *
 * @param entry The (already-sanitized) entry to render.
 * @returns Markdown block ending with a trailing newline.
 */
function renderEntryBody(entry: FailureEntry): string {
  const lines: string[] = [];
  const date = entry.date ?? todayUtc();
  lines.push(`### ${date} — ${entry.symptom}`);
  lines.push(`- Root cause: ${entry.root_cause}`);
  lines.push(`- Prevention: ${entry.prevention}`);
  if (entry.related_files && entry.related_files.length > 0) {
    lines.push(`- Related: ${entry.related_files.join(", ")}`);
  }
  return lines.join("\n") + "\n";
}

/** Render the full block including the failure-id marker. */
function renderBlock(hash: string, entry: FailureEntry): string {
  return `<!-- failure-id: ${hash} -->\n${renderEntryBody(entry)}`;
}

/**
 * Parse the `## Known failure modes` section out of file content into an
 * ordered list of blocks (top-to-bottom = newest-first).
 *
 * @param content Full file content.
 * @returns Parsed blocks, or empty array if the section is missing.
 */
function parseSection(content: string): ParsedBlock[] {
  const sectionIdx = content.indexOf(SECTION_HEADER);
  if (sectionIdx === -1) return [];
  // Body of the section is from the header through the next `## ` header
  // (or end of file).
  const afterHeader = content.slice(sectionIdx + SECTION_HEADER.length);
  const nextHeaderMatch = afterHeader.match(/\n## /);
  const body =
    nextHeaderMatch && nextHeaderMatch.index !== undefined
      ? afterHeader.slice(0, nextHeaderMatch.index)
      : afterHeader;

  const blocks: ParsedBlock[] = [];
  const markerRegex = /<!-- failure-id: ([a-f0-9]+) -->\n([\s\S]*?)(?=<!-- failure-id: |\n## |$)/g;
  let m: RegExpExecArray | null;
  while ((m = markerRegex.exec(body)) !== null) {
    const hash = m[1] ?? "";
    const blockBody = (m[2] ?? "").trimEnd() + "\n";
    const entry = parseBlockBody(blockBody);
    if (entry) {
      blocks.push({ hash, raw: blockBody, entry });
    }
  }
  return blocks;
}

/**
 * Parse a single entry block (without the marker line) back into a
 * {@link FailureEntry}. Returns null if the block doesn't look well-formed.
 */
function parseBlockBody(blockBody: string): FailureEntry | null {
  const lines = blockBody.split("\n");
  const headerLine = lines.find((l) => l.startsWith("### "));
  if (!headerLine) return null;
  const headerRest = headerLine.slice(4);
  // Header form: "<date> — <symptom>"
  const sepIdx = headerRest.indexOf(" — ");
  if (sepIdx === -1) return null;
  const date = headerRest.slice(0, sepIdx).trim();
  const symptom = headerRest.slice(sepIdx + 3).trim();

  const rootLine = lines.find((l) => l.startsWith("- Root cause:"));
  const preventionLine = lines.find((l) => l.startsWith("- Prevention:"));
  const relatedLine = lines.find((l) => l.startsWith("- Related:"));

  if (!rootLine || !preventionLine) return null;

  const entry: FailureEntry = {
    symptom,
    root_cause: rootLine.replace(/^- Root cause:\s*/, "").trim(),
    prevention: preventionLine.replace(/^- Prevention:\s*/, "").trim(),
    date,
  };
  if (relatedLine) {
    const relStr = relatedLine.replace(/^- Related:\s*/, "").trim();
    entry.related_files = relStr
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return entry;
}

/**
 * Write the updated section into the file content. Returns the new content.
 *
 * @param oldContent Existing file content (may be empty string).
 * @param blocks Blocks in display order (newest-first).
 * @returns The updated file content.
 */
function writeSection(oldContent: string, blocks: ParsedBlock[]): string {
  const renderedBlocks = blocks.map((b) => renderBlock(b.hash, b.entry)).join("\n");
  const sectionBody = `${SECTION_HEADER}\n${PROVENANCE_MARKER}\n\n${renderedBlocks}`;

  const sectionIdx = oldContent.indexOf(SECTION_HEADER);
  if (sectionIdx === -1) {
    // Append to end.
    if (oldContent.length === 0) {
      return sectionBody;
    }
    const sep = oldContent.endsWith("\n\n") ? "" : oldContent.endsWith("\n") ? "\n" : "\n\n";
    return `${oldContent}${sep}${sectionBody}`;
  }

  // Replace from section header through the next `## ` (or EOF).
  const afterHeader = oldContent.slice(sectionIdx + SECTION_HEADER.length);
  const nextHeaderMatch = afterHeader.match(/\n## /);
  const tail =
    nextHeaderMatch && nextHeaderMatch.index !== undefined
      ? afterHeader.slice(nextHeaderMatch.index)
      : "";
  const head = oldContent.slice(0, sectionIdx);
  return `${head}${sectionBody}${tail}`;
}

/**
 * Resolve and validate that `<cwd>/<basename>` is within `<cwd>`.
 * Throws if the resolved target escapes the workspace root.
 */
function resolveSafeTarget(cwd: string, basename: string): string {
  const target = resolve(cwd, basename);
  if (!isWithin(cwd, target)) {
    const err = new Error(
      `refused to write outside workspace: target=${target} cwd=${cwd}`,
    );
    (err as Error & { cause?: unknown }).cause = { kind: "path_resolution" };
    throw err;
  }
  return target;
}

/**
 * Append (or dedupe) a single failure entry to AGENTS.md and optionally
 * mirror it to CLAUDE.md.
 *
 * Behavior:
 *   - If an entry with the same symptom-hash already exists in a target
 *     file, that file is left UNCHANGED and the result carries
 *     `deduplicated: true`.
 *   - If the target file lacks the `## Known failure modes` section, it is
 *     created at the end of the file (or as the entire file if the file
 *     doesn't exist).
 *   - Entries are written in reverse-chronological order — the newest entry
 *     sits directly under the section header.
 *
 * @param entry The failure to record.
 * @param opts  Optional behavior overrides.
 * @returns One {@link AppendResult} per file written or considered.
 * @throws When a write target resolves outside `opts.cwd`.
 */
export async function appendFailure(
  entry: FailureEntry,
  opts?: AppendOptions,
): Promise<AppendResult[]> {
  if (!entry.symptom || entry.symptom.trim().length === 0) {
    throw new Error("failureLog.appendFailure: symptom must be non-empty");
  }
  if (!entry.root_cause || entry.root_cause.trim().length === 0) {
    throw new Error("failureLog.appendFailure: root_cause must be non-empty");
  }
  if (!entry.prevention || entry.prevention.trim().length === 0) {
    throw new Error("failureLog.appendFailure: prevention must be non-empty");
  }

  const cwd = opts?.cwd ?? process.cwd();
  const mirror = opts?.mirror_to_claude_md ?? true;
  const sanitized = opts?.skip_sanitization ? entry : sanitizeEntry(entry);
  const hash = symptomHash(sanitized.symptom);

  const targets: string[] = [resolveSafeTarget(cwd, "AGENTS.md")];
  if (mirror) {
    const claudePath = resolveSafeTarget(cwd, "CLAUDE.md");
    if (existsSync(claudePath)) targets.push(claudePath);
  }

  const results: AppendResult[] = [];
  for (const file of targets) {
    const before = existsSync(file) ? readFileSync(file, "utf-8") : "";
    const blocks = parseSection(before);
    const existsAlready = blocks.some((b) => b.hash === hash);

    if (existsAlready) {
      log.debug("appendFailure deduplicated entry", { file, hash });
      results.push({ file, deduplicated: true, total_entries: blocks.length });
      continue;
    }

    const newBlock: ParsedBlock = {
      hash,
      raw: renderEntryBody(sanitized),
      entry: { ...sanitized, date: sanitized.date ?? todayUtc() },
    };
    const updated: ParsedBlock[] = [newBlock, ...blocks];
    const newContent = writeSection(before, updated);
    writeFileSync(file, newContent, { mode: 0o644 });

    log.info("appendFailure wrote entry", {
      file,
      hash,
      total_entries: updated.length,
    });
    results.push({ file, deduplicated: false, total_entries: updated.length });
  }

  return results;
}

/**
 * Read back the entries from `## Known failure modes` in
 * `<cwd>/AGENTS.md` (or a caller-supplied file path) in their stored order
 * (newest-first).
 *
 * @param opts Optional source overrides.
 * @returns Parsed entries, newest first. Empty when the section is absent.
 * @throws When `opts.file` resolves outside `opts.cwd`.
 */
export async function listFailures(opts?: {
  cwd?: string;
  file?: string;
}): Promise<FailureEntry[]> {
  const cwd = opts?.cwd ?? process.cwd();
  const file = opts?.file ? resolve(opts.file) : resolveSafeTarget(cwd, "AGENTS.md");
  if (opts?.file && !isWithin(cwd, file)) {
    const err = new Error(
      `refused to read outside workspace: file=${file} cwd=${cwd}`,
    );
    (err as Error & { cause?: unknown }).cause = { kind: "path_resolution" };
    throw err;
  }
  if (!existsSync(file)) return [];
  const content = readFileSync(file, "utf-8");
  return parseSection(content).map((b) => b.entry);
}
