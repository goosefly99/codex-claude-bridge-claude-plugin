/**
 * AGENTS.md / CLAUDE.md sync engine for the `agents-md-sync` skill.
 *
 * OpenAI Codex auto-loads `AGENTS.md` at session start; Claude Code's
 * equivalent is `CLAUDE.md`. The schemas are near-identical, so a single
 * shared file can drive both — this module is the source of truth for
 * detecting which side exists, bootstrapping from a lean template, mirroring
 * one side into the other, and diffing at the section level.
 *
 * Lean-schema rule (Riley Brown: *"don't stuff everything in"*):
 *   The five allowed level-2 sections are User identity, Project goal,
 *   Style preferences, Standing rules, Known failure modes. The last is
 *   owned by the `failure-as-knowledge` skill and is preserved verbatim
 *   from the destination during any mirror operation (detected via the
 *   `<!-- managed-by: failure-as-knowledge -->` marker).
 *
 * Hard invariants:
 *   - Every write target is gated through `paths.isWithin(cwd, target)`.
 *     Paths outside the workspace are refused.
 *   - The Known-failure-modes section (or any other `managed-by` section)
 *     is never propagated from one file to the other.
 *   - No auto-commit: callers must surface the diff and let the user decide.
 *
 * @module scripts/knowledge/agentsMd
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getLogger } from "../util/log.js";
import { isWithin, normalize } from "../util/paths.js";

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = resolve(dirname(__filename), "..", "..");

const log = getLogger("agentsMd");

const AGENTS_FILENAME = "AGENTS.md";
const CLAUDE_FILENAME = "CLAUDE.md";
const TEMPLATE_PATH = resolve(PLUGIN_ROOT, "skills", "agents-md-sync", "template.md");

/**
 * The five distinct states a workspace can be in with respect to its
 * AGENTS.md and CLAUDE.md.
 */
export type AgentsMdState = "none" | "agents_only" | "claude_only" | "both_present" | "both_diverged";

/**
 * A parsed level-2 section of an AGENTS.md or CLAUDE.md file.
 */
export interface AgentsMdSection {
  /** The heading text (without leading `##` or trailing whitespace). */
  heading: string;
  /** Markdown header level. Always 2 for the lean schema, but parsed generally. */
  level: number;
  /** Text content of the section, excluding the heading line itself. */
  body: string;
  /** True if this section is managed by another skill and should not be touched. */
  managed_by?: string;
}

/**
 * Result of inspecting a workspace's AGENTS.md / CLAUDE.md state.
 */
export interface DetectResult {
  /** Coarse state summary used to branch the sync workflow. */
  state: AgentsMdState;
  /** Resolved absolute path to AGENTS.md (even if file does not exist). */
  agents_path: string;
  /** Resolved absolute path to CLAUDE.md (even if file does not exist). */
  claude_path: string;
  /** Parsed sections of AGENTS.md; empty array if file is missing. */
  agents_sections: AgentsMdSection[];
  /** Parsed sections of CLAUDE.md; empty array if file is missing. */
  claude_sections: AgentsMdSection[];
}

/**
 * Per-section diff status across AGENTS.md and CLAUDE.md.
 */
export interface DiffEntry {
  /** Section heading (level-2, no leading `##`). */
  heading: string;
  /** Diff classification for this section. */
  status: "same" | "agents_only" | "claude_only" | "diverged";
}

/**
 * Options accepted by mirror operations.
 */
export interface SyncOptions {
  /** Workspace root. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * If true (default), any section marked `<!-- managed-by: X -->` in the
   * destination file is preserved verbatim and not overwritten from the
   * source. If false, the source overwrites everything.
   */
  preserve_managed?: boolean;
}

/**
 * Parse a markdown string into an ordered list of sections, splitting on
 * level-2 (`## `) headings.
 *
 * @param markdown The raw markdown contents.
 * @returns Ordered sections. Content before the first `## ` is discarded
 *   (treated as preamble / file title and not synced).
 */
export function parseSections(markdown: string): AgentsMdSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: AgentsMdSection[] = [];

  let current: AgentsMdSection | null = null;
  let bodyLines: string[] = [];

  for (const line of lines) {
    const match = /^(#{2,6})\s+(.+?)\s*$/.exec(line);
    if (match && match[1] && match[1].length === 2) {
      // Close the previous section, if any.
      if (current) {
        current.body = bodyLines.join("\n").replace(/\s+$/, "");
        sections.push(current);
      }
      const heading = match[2] ?? "";
      current = { heading, level: 2, body: "" };
      bodyLines = [];
    } else if (current) {
      // Detect `<!-- managed-by: X -->` on the first non-blank line after
      // the heading (and before any other content). We accept it anywhere
      // in the body — the tooling-owned `failure-as-knowledge` block lives
      // immediately under the header.
      const managed = /<!--\s*managed-by:\s*([A-Za-z0-9_\-]+)\s*-->/.exec(line);
      if (managed && managed[1] && current.managed_by === undefined) {
        current.managed_by = managed[1];
      }
      bodyLines.push(line);
    }
  }

  if (current) {
    current.body = bodyLines.join("\n").replace(/\s+$/, "");
    sections.push(current);
  }

  return sections;
}

/**
 * Render an ordered list of sections back to a markdown string, prefixed by
 * the AGENTS.md preamble (title + lead paragraph). Used by bootstrap and
 * mirror operations to materialize the synced file.
 *
 * @param sections The sections to render, in order.
 * @param title Optional level-1 title line (default `# AGENTS.md`).
 * @param preamble Optional preamble text inserted between the title and the
 *   first section.
 * @returns A canonical markdown rendering.
 */
export function renderSections(
  sections: AgentsMdSection[],
  title: string = "# AGENTS.md",
  preamble: string = "",
): string {
  const parts: string[] = [title, ""];
  if (preamble.trim().length > 0) {
    parts.push(preamble.trim());
    parts.push("");
  }
  for (const s of sections) {
    parts.push(`## ${s.heading}`);
    if (s.body.length > 0) {
      parts.push("");
      parts.push(s.body);
    }
    parts.push("");
  }
  return parts.join("\n").replace(/\s+$/, "") + "\n";
}

function resolveCwd(opts: { cwd?: string } | undefined): string {
  return normalize(opts?.cwd ?? process.cwd());
}

function assertWithinCwd(cwd: string, target: string): void {
  if (!isWithin(cwd, target)) {
    const err = new Error(`refusing to write outside workspace: ${target}`);
    (err as Error & { cause?: unknown }).cause = { kind: "path_resolution" };
    throw err;
  }
}

function readIfExists(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch (err) {
    log.warn("failed to read context file", { path, err: String(err) });
    return null;
  }
}

function sectionsEqual(a: AgentsMdSection[], b: AgentsMdSection[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (!left || !right) return false;
    if (left.heading !== right.heading) return false;
    if (left.body !== right.body) return false;
  }
  return true;
}

/**
 * Inspect a workspace and report the current AGENTS.md / CLAUDE.md state.
 *
 * @param opts Optional override for the workspace root.
 * @returns A {@link DetectResult} describing both files.
 */
export async function detect(opts?: { cwd?: string }): Promise<DetectResult> {
  const cwd = resolveCwd(opts);
  const agentsPath = resolve(cwd, AGENTS_FILENAME);
  const claudePath = resolve(cwd, CLAUDE_FILENAME);

  const agentsRaw = readIfExists(agentsPath);
  const claudeRaw = readIfExists(claudePath);

  const agentsSections = agentsRaw ? parseSections(agentsRaw) : [];
  const claudeSections = claudeRaw ? parseSections(claudeRaw) : [];

  let state: AgentsMdState;
  if (agentsRaw === null && claudeRaw === null) {
    state = "none";
  } else if (agentsRaw !== null && claudeRaw === null) {
    state = "agents_only";
  } else if (agentsRaw === null && claudeRaw !== null) {
    state = "claude_only";
  } else if (sectionsEqual(agentsSections, claudeSections)) {
    state = "both_present";
  } else {
    state = "both_diverged";
  }

  log.debug("detected state", { state, cwd });
  return {
    state,
    agents_path: agentsPath,
    claude_path: claudePath,
    agents_sections: agentsSections,
    claude_sections: claudeSections,
  };
}

/**
 * Create a fresh AGENTS.md from the lean template, if one doesn't already
 * exist (or if explicitly overwriting).
 *
 * @param opts.cwd Workspace root. Defaults to `process.cwd()`.
 * @param opts.overwrite If true, overwrite an existing AGENTS.md. Defaults
 *   to false; the function returns `{ written: false }` and leaves the file
 *   untouched otherwise.
 * @returns The resolved file path and whether it was actually written.
 */
export async function bootstrap(
  opts?: { cwd?: string; overwrite?: boolean },
): Promise<{ file: string; written: boolean }> {
  const cwd = resolveCwd(opts);
  const target = resolve(cwd, AGENTS_FILENAME);
  assertWithinCwd(cwd, target);

  if (existsSync(target) && opts?.overwrite !== true) {
    log.info("bootstrap skipped: AGENTS.md already exists", { target });
    return { file: target, written: false };
  }

  const template = readFileSync(TEMPLATE_PATH, "utf-8");
  writeFileSync(target, template, { mode: 0o644 });
  log.info("bootstrap wrote AGENTS.md", { target });
  return { file: target, written: true };
}

interface MirrorPlan {
  source_sections: AgentsMdSection[];
  destination_sections: AgentsMdSection[];
  preserve_managed: boolean;
}

function mergeSections(plan: MirrorPlan): { sections: AgentsMdSection[]; changed: string[] } {
  const sourceMap = new Map<string, AgentsMdSection>();
  for (const s of plan.source_sections) sourceMap.set(s.heading, s);
  const destMap = new Map<string, AgentsMdSection>();
  for (const s of plan.destination_sections) destMap.set(s.heading, s);

  const changed: string[] = [];
  const out: AgentsMdSection[] = [];

  for (const s of plan.source_sections) {
    const destExisting = destMap.get(s.heading);

    // Preserve a managed-by section from the destination verbatim.
    if (plan.preserve_managed && destExisting && destExisting.managed_by !== undefined) {
      out.push(destExisting);
      continue;
    }
    if (plan.preserve_managed && s.managed_by !== undefined && destExisting) {
      // Source has a managed-by section but destination has its own copy —
      // prefer the destination's version so we don't propagate.
      out.push(destExisting);
      continue;
    }

    out.push({ heading: s.heading, level: s.level, body: s.body, ...(s.managed_by !== undefined ? { managed_by: s.managed_by } : {}) });
    if (!destExisting || destExisting.body !== s.body) {
      changed.push(s.heading);
    }
  }

  // Any destination-only section that is managed-by must survive — append it
  // at the end so the user doesn't lose tooling-owned state.
  for (const s of plan.destination_sections) {
    if (sourceMap.has(s.heading)) continue;
    if (plan.preserve_managed && s.managed_by !== undefined) {
      out.push(s);
    }
  }

  return { sections: out, changed };
}

function buildPreamble(forFile: "AGENTS.md" | "CLAUDE.md"): string {
  if (forFile === "AGENTS.md") {
    return "This file is auto-loaded by OpenAI Codex on session start. Keep it lean — Codex reads the codebase already.";
  }
  return "This file is auto-loaded by Claude Code on session start. Keep it lean — Claude reads the codebase already.";
}

function summarizeDiff(changed: string[]): string {
  if (changed.length === 0) return "no section changes";
  if (changed.length === 1) return `updated section: ${changed[0]}`;
  return `updated sections: ${changed.join(", ")}`;
}

/**
 * Copy AGENTS.md to CLAUDE.md, preserving any `managed-by` section already in
 * CLAUDE.md (those are owned by other skills and must not be propagated).
 *
 * @param opts See {@link SyncOptions}.
 * @returns Whether CLAUDE.md was actually written, plus a 1-line summary.
 */
export async function mirrorToClaude(opts?: SyncOptions): Promise<{ written: boolean; diff_summary: string }> {
  const cwd = resolveCwd(opts);
  const agentsPath = resolve(cwd, AGENTS_FILENAME);
  const claudePath = resolve(cwd, CLAUDE_FILENAME);
  assertWithinCwd(cwd, claudePath);

  if (!existsSync(agentsPath)) {
    throw new Error("AGENTS.md does not exist — cannot mirror to CLAUDE.md");
  }
  const agentsRaw = readFileSync(agentsPath, "utf-8");
  const claudeRaw = readIfExists(claudePath);

  const source = parseSections(agentsRaw);
  const destination = claudeRaw ? parseSections(claudeRaw) : [];

  const preserve = opts?.preserve_managed !== false;
  const { sections, changed } = mergeSections({
    source_sections: source,
    destination_sections: destination,
    preserve_managed: preserve,
  });

  const next = renderSections(sections, "# CLAUDE.md", buildPreamble("CLAUDE.md"));
  if (claudeRaw === next) {
    log.info("mirrorToClaude: no changes", { claudePath });
    return { written: false, diff_summary: "no section changes" };
  }

  writeFileSync(claudePath, next, { mode: 0o644 });
  log.info("mirrorToClaude wrote CLAUDE.md", { claudePath, changed });
  return { written: true, diff_summary: summarizeDiff(changed) };
}

/**
 * Copy CLAUDE.md to AGENTS.md, preserving any `managed-by` section already in
 * AGENTS.md (those are owned by other skills and must not be propagated).
 *
 * @param opts See {@link SyncOptions}.
 * @returns Whether AGENTS.md was actually written, plus a 1-line summary.
 */
export async function mirrorFromClaude(opts?: SyncOptions): Promise<{ written: boolean; diff_summary: string }> {
  const cwd = resolveCwd(opts);
  const agentsPath = resolve(cwd, AGENTS_FILENAME);
  const claudePath = resolve(cwd, CLAUDE_FILENAME);
  assertWithinCwd(cwd, agentsPath);

  if (!existsSync(claudePath)) {
    throw new Error("CLAUDE.md does not exist — cannot mirror from it");
  }
  const claudeRaw = readFileSync(claudePath, "utf-8");
  const agentsRaw = readIfExists(agentsPath);

  const source = parseSections(claudeRaw);
  const destination = agentsRaw ? parseSections(agentsRaw) : [];

  const preserve = opts?.preserve_managed !== false;
  const { sections, changed } = mergeSections({
    source_sections: source,
    destination_sections: destination,
    preserve_managed: preserve,
  });

  const next = renderSections(sections, "# AGENTS.md", buildPreamble("AGENTS.md"));
  if (agentsRaw === next) {
    log.info("mirrorFromClaude: no changes", { agentsPath });
    return { written: false, diff_summary: "no section changes" };
  }

  writeFileSync(agentsPath, next, { mode: 0o644 });
  log.info("mirrorFromClaude wrote AGENTS.md", { agentsPath, changed });
  return { written: true, diff_summary: summarizeDiff(changed) };
}

/**
 * Per-section diff between AGENTS.md and CLAUDE.md. Returns one
 * {@link DiffEntry} for each section heading found in either file.
 *
 * @param opts.cwd Workspace root. Defaults to `process.cwd()`.
 * @returns One entry per heading, classified as same / agents_only /
 *   claude_only / diverged.
 */
export async function sectionDiff(opts?: { cwd?: string }): Promise<DiffEntry[]> {
  const det = await detect(opts);
  const agentsMap = new Map<string, AgentsMdSection>();
  for (const s of det.agents_sections) agentsMap.set(s.heading, s);
  const claudeMap = new Map<string, AgentsMdSection>();
  for (const s of det.claude_sections) claudeMap.set(s.heading, s);

  const order: string[] = [];
  const seen = new Set<string>();
  for (const s of det.agents_sections) {
    if (!seen.has(s.heading)) {
      order.push(s.heading);
      seen.add(s.heading);
    }
  }
  for (const s of det.claude_sections) {
    if (!seen.has(s.heading)) {
      order.push(s.heading);
      seen.add(s.heading);
    }
  }

  const out: DiffEntry[] = [];
  for (const heading of order) {
    const a = agentsMap.get(heading);
    const c = claudeMap.get(heading);
    if (a && c) {
      out.push({ heading, status: a.body === c.body ? "same" : "diverged" });
    } else if (a) {
      out.push({ heading, status: "agents_only" });
    } else if (c) {
      out.push({ heading, status: "claude_only" });
    }
  }
  return out;
}
