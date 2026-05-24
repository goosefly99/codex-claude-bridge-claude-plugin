/**
 * Greenfield git handler — edge-case support for repos with no commits.
 *
 * When /codex:diff-review or /codex:adversarial-diff-review runs on a
 * freshly-`git init`-ed workspace, there is no diff target. This module
 * transparently creates a throwaway `codex-review-base` branch with an empty
 * initial commit so a diff can be computed against it. After the review runs,
 * the throwaway branch is deleted. The general-purpose /codex:review and
 * /codex:adversarial-review commands do not need this — they walk paths
 * directly via scripts/codex/fsContext.ts.
 *
 * Hard rules:
 *   - Never auto-init a non-git directory. If the user has no repo, exit code 3
 *     with a clear "run `git init` first" message.
 *   - All work happens on a side branch; HEAD is never touched.
 *
 * @module scripts/git/greenfield
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../util/log.js";

const log = getLogger("greenfield");
const THROWAWAY_REF = "codex-review-base";

export type GitState = "no_repo" | "empty_repo" | "populated_repo";

export interface ReviewBase {
  base: string;
  head: string;
  is_throwaway: boolean;
  throwaway_ref: string | null;
}

function runGit(args: string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync("git", args, { encoding: "utf-8" });
  return {
    code: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

export async function detectGitState(): Promise<GitState> {
  if (!existsSync(join(process.cwd(), ".git"))) {
    const inside = runGit(["rev-parse", "--is-inside-work-tree"]);
    if (inside.code !== 0) return "no_repo";
  }
  const headCheck = runGit(["rev-parse", "--verify", "HEAD"]);
  if (headCheck.code === 0) return "populated_repo";
  return "empty_repo";
}

function noRepoError(): Error {
  const err = new Error("not a git repository; run `git init` first");
  (err as Error & { cause?: unknown }).cause = { kind: "no_git_repo" };
  return err;
}

function gitStateError(detail: string): Error {
  const err = new Error(`git state error: ${detail}`);
  (err as Error & { cause?: unknown }).cause = { kind: "git_state" };
  return err;
}

export async function prepareReviewBase(): Promise<ReviewBase> {
  const state = await detectGitState();

  if (state === "no_repo") throw noRepoError();

  if (state === "populated_repo") {
    const head = runGit(["rev-parse", "HEAD"]);
    if (head.code !== 0) throw gitStateError(head.stderr.trim());
    return {
      base: "HEAD",
      head: "HEAD",
      is_throwaway: false,
      throwaway_ref: null,
    };
  }

  // empty_repo path: stage everything, create the throwaway branch with a
  // single empty initial commit. We never touch the user's HEAD (it doesn't
  // exist yet — empty repo).
  const refCheck = runGit(["show-ref", "--verify", `refs/heads/${THROWAWAY_REF}`]);
  if (refCheck.code === 0) {
    log.debug("throwaway branch already exists; reusing", { ref: THROWAWAY_REF });
    return {
      base: THROWAWAY_REF,
      head: "HEAD",
      is_throwaway: true,
      throwaway_ref: THROWAWAY_REF,
    };
  }

  // Use --allow-empty so we don't need any staged files.
  const checkout = runGit(["checkout", "--orphan", THROWAWAY_REF]);
  if (checkout.code !== 0) throw gitStateError(checkout.stderr.trim());

  const cleanIndex = runGit(["rm", "-rf", "--cached", "."]);
  // Empty repo: nothing to clean. Ignore non-zero exit on this one.
  if (cleanIndex.code !== 0)
    log.debug("rm --cached returned non-zero (likely empty)", { stderr: cleanIndex.stderr });

  const commit = runGit([
    "-c",
    "user.email=codex-bridge@local",
    "-c",
    "user.name=codex-bridge",
    "commit",
    "--allow-empty",
    "-m",
    "codex-review-base (throwaway)",
  ]);
  if (commit.code !== 0) throw gitStateError(commit.stderr.trim());

  // Detach so we're not "on" the throwaway branch; revert to working-tree state.
  const detach = runGit(["checkout", "--detach"]);
  if (detach.code !== 0) {
    // Non-fatal — user can recover. Log and continue.
    log.warn("post-throwaway detach failed", { stderr: detach.stderr });
  }

  return {
    base: THROWAWAY_REF,
    head: "HEAD",
    is_throwaway: true,
    throwaway_ref: THROWAWAY_REF,
  };
}

export async function cleanupReviewBase(refName: string): Promise<boolean> {
  const exists = runGit(["show-ref", "--verify", `refs/heads/${refName}`]);
  if (exists.code !== 0) return false;
  const del = runGit(["branch", "-D", refName]);
  return del.code === 0;
}
