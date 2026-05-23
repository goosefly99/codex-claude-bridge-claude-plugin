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
 * Either threshold being exceeded triggers "background" classification.
 * Explicit --background / --wait flags should be honored by callers BEFORE
 * calling this classifier (i.e. classification is only consulted when no flag
 * was provided).
 *
 * @module scripts/codex/sizeClassifier
 */

/** The classification verdict. */
export type DiffClass = "sync" | "background";

/** Size statistics computed from `git diff --stat`. */
export interface DiffStats {
  /** Number of files with at least one change. */
  files_changed: number;
  /** Total lines added across all changed files. */
  insertions: number;
  /** Total lines deleted across all changed files. */
  deletions: number;
}

/** Threshold configuration loaded from config.json with defaults. */
export interface ClassifierThresholds {
  diff_files_threshold: number; // default 8
  diff_loc_threshold: number; // default 500
}

/**
 * Classify the size of the given diff target.
 *
 * Behavior:
 *   1. Run `git diff --stat` (or branch-comparison equivalent) for the target.
 *   2. Parse files-changed and total +/- LOC.
 *   3. Apply the threshold rule:
 *        files > diff_files_threshold OR
 *        insertions + deletions > diff_loc_threshold
 *      => "background"; else "sync".
 *
 * @param target Optional git ref/refspec. Default: uncommitted working-tree.
 * @returns The DiffClass verdict.
 * @throws ErrorKind.git_state if `git diff` fails or the workspace has no repo.
 */
export async function classifyDiff(_target?: string): Promise<DiffClass> {
  throw new Error("not implemented");
}

/**
 * Compute raw diff statistics. Exposed for testability and so /codex:status
 * can report file counts alongside its job-state output.
 *
 * @param target Optional git ref/refspec.
 * @returns Parsed DiffStats.
 */
export async function getDiffStats(_target?: string): Promise<DiffStats> {
  throw new Error("not implemented");
}

/**
 * Load thresholds from config.json with defaults applied. Pure function over
 * config; does not consult the filesystem.
 *
 * @returns ClassifierThresholds.
 */
export function loadThresholds(): ClassifierThresholds {
  throw new Error("not implemented");
}
