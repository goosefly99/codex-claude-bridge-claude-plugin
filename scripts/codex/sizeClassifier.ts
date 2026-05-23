/**
 * Diff-size auto-classifier.
 *
 * Decides whether a review runs synchronously (small diff) or in the
 * background (large diff) before any Codex API call is made. Runs entirely
 * client-side from `git diff --stat` output.
 *
 * Default thresholds (tunable via config.json):
 *   - 8 changed files
 *   - 500 added+deleted LOC delta
 *
 * @module scripts/codex/sizeClassifier
 */

import { spawnSync } from "node:child_process";

import { getConfig, DEFAULT_CONFIG } from "../util/config.js";
import { getLogger } from "../util/log.js";

const log = getLogger("sizeClassifier");

export type DiffClass = "sync" | "background";

export interface DiffStats {
  files_changed: number;
  insertions: number;
  deletions: number;
}

export interface ClassifierThresholds {
  diff_files_threshold: number;
  diff_loc_threshold: number;
}

function runGitDiffStat(target?: string): string {
  const args = ["diff", "--numstat"];
  if (target) args.push(target);
  const res = spawnSync("git", args, { encoding: "utf-8" });
  if (res.status !== 0) {
    const err = new Error(
      `git diff --numstat failed: ${res.stderr?.trim() ?? "(no stderr)"}`,
    );
    (err as Error & { cause?: unknown }).cause = { kind: "git_state" };
    throw err;
  }
  return res.stdout ?? "";
}

function parseNumstat(stdout: string): DiffStats {
  let files = 0;
  let ins = 0;
  let dels = 0;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const a = parts[0];
    const d = parts[1];
    files += 1;
    if (a && a !== "-") ins += Number(a);
    if (d && d !== "-") dels += Number(d);
  }
  return { files_changed: files, insertions: ins, deletions: dels };
}

export async function getDiffStats(target?: string): Promise<DiffStats> {
  const stdout = runGitDiffStat(target);
  const stats = parseNumstat(stdout);
  log.debug("git diff stats", stats as unknown as Record<string, unknown>);
  return stats;
}

export async function classifyDiff(target?: string): Promise<DiffClass> {
  const stats = await getDiffStats(target);
  const t = await loadThresholdsAsync();
  if (
    stats.files_changed > t.diff_files_threshold ||
    stats.insertions + stats.deletions > t.diff_loc_threshold
  ) {
    return "background";
  }
  return "sync";
}

async function loadThresholdsAsync(): Promise<ClassifierThresholds> {
  const cfg = await getConfig();
  return {
    diff_files_threshold: cfg.diff_files_threshold,
    diff_loc_threshold: cfg.diff_loc_threshold,
  };
}

/**
 * Load thresholds synchronously from defaults. Exposed for unit tests that
 * don't want to await config loading.
 */
export function loadThresholds(): ClassifierThresholds {
  return {
    diff_files_threshold: DEFAULT_CONFIG.diff_files_threshold,
    diff_loc_threshold: DEFAULT_CONFIG.diff_loc_threshold,
  };
}
