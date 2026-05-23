/**
 * Greenfield git handler — edge-case support for repos with no commits.
 *
 * When /codex:adversarial-review or /codex:review runs on a freshly-`git
 * init`-ed workspace, there is no diff target. This module transparently
 * creates a throwaway `codex-review-base` branch with an empty initial commit
 * so a diff can be computed against it. After the review runs, the throwaway
 * branch is deleted.
 *
 * Hard rules:
 *   - Never auto-init a non-git directory. If the user has no repo, exit code 3
 *     with a clear "run `git init` first" message. Auto-init crosses an
 *     autonomy line.
 *   - All work happens on a side branch; HEAD is never touched.
 *   - Any failure rolls back so the user's repo is untouched.
 *
 * @module scripts/git/greenfield
 */

/** Detected git state of the current workspace. */
export type GitState =
  /** No `.git` directory; not a git repo. */
  | "no_repo"
  /** Repo exists but has zero commits. */
  | "empty_repo"
  /** Normal repo with at least one commit. */
  | "populated_repo";

/** Result of prepareReviewBase. */
export interface ReviewBase {
  /** The base ref to diff against (a commit hash or branch name). */
  base: string;
  /** The head ref (typically HEAD or the working tree). */
  head: string;
  /** True if a throwaway ref was created and should be cleaned up later. */
  is_throwaway: boolean;
  /** The throwaway branch name, if created (for cleanup). */
  throwaway_ref: string | null;
}

/**
 * Detect the git state of the current workspace.
 *
 * @returns The detected GitState.
 */
export async function detectGitState(): Promise<GitState> {
  throw new Error("not implemented");
}

/**
 * Prepare a diff base for review. Handles the greenfield case by creating a
 * throwaway branch when no commits exist. Idempotent and safe to call
 * repeatedly: if a throwaway branch already exists from a prior aborted run,
 * it is reused.
 *
 * Behavior:
 *   - "no_repo": throw ErrorKind.no_git_repo (exit 3). DO NOT auto-init.
 *   - "empty_repo": stage all working-tree files, create an empty initial
 *     commit on a throwaway `codex-review-base` branch, return that ref as
 *     base and HEAD-after-commit as head.
 *   - "populated_repo": resolve the user-provided ref (or default to
 *     uncommitted changes) and return without creating any throwaway.
 *
 * @returns The ReviewBase with concrete refs.
 * @throws ErrorKind.no_git_repo if there is no git repo at the workspace.
 * @throws ErrorKind.git_state on any other git failure (rolls back first).
 */
export async function prepareReviewBase(): Promise<ReviewBase> {
  throw new Error("not implemented");
}

/**
 * Clean up a throwaway ref created by prepareReviewBase. Idempotent.
 *
 * @param refName The throwaway branch name to delete.
 * @returns true if the ref existed and was deleted; false otherwise.
 */
export async function cleanupReviewBase(_refName: string): Promise<boolean> {
  throw new Error("not implemented");
}
