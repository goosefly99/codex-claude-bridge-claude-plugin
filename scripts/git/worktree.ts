/**
 * Throwaway git worktree manager for parallel delegations.
 *
 * The `implement-with-codex` skill uses this when `delegator_isolate_worktrees`
 * is true. Each parallel Codex agent gets its own worktree so concurrent file
 * mutations don't collide. After the agent finishes, the worktree is removed
 * (unless `keep: true` is passed for inspection).
 *
 * Hard rules:
 *   - Worktrees live under `${CLAUDE_PLUGIN_DATA}/codex-bridge/worktrees/`,
 *     NEVER under the repo itself. We don't want them polluting `git status`.
 *   - Names are deterministic prefix + random suffix: `codex-delegate-<8 hex>`.
 *   - On cleanup, run `git worktree remove --force` and `prune` to be safe.
 *
 * @module scripts/git/worktree
 */

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { getLogger } from "../util/log.js";

const log = getLogger("worktree");

export interface WorktreeHandle {
  /** Absolute path to the worktree root. */
  path: string;
  /** Branch name the worktree is checked out on. */
  branch: string;
  /** Whether this is a throwaway (true) or pre-existing (false). */
  is_throwaway: boolean;
}

export interface CreateOptions {
  /** Base ref or commit to spawn the worktree from. Defaults to HEAD. */
  base?: string;
  /** Custom branch name. Defaults to `codex-delegate-<rand>`. */
  branch?: string;
}

function worktreesRoot(): string {
  const data =
    process.env["CLAUDE_PLUGIN_DATA"] ?? join(homedir(), ".claude", "plugin-data");
  return join(data, "codex-bridge", "worktrees");
}

function runGit(args: string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync("git", args, { encoding: "utf-8" });
  return {
    code: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function makeBranchName(): string {
  return `codex-delegate-${randomBytes(4).toString("hex")}`;
}

/**
 * Create a fresh throwaway worktree branched from `base` (default HEAD).
 *
 * @param opts CreateOptions.
 * @returns A WorktreeHandle the caller can use to scope file ops.
 * @throws ErrorKind.git_state on git failure.
 */
export async function create(opts?: CreateOptions): Promise<WorktreeHandle> {
  const root = worktreesRoot();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });

  const branch = opts?.branch ?? makeBranchName();
  const path = join(root, branch);
  const base = opts?.base ?? "HEAD";

  const addArgs = ["worktree", "add", "-b", branch, path, base];
  const res = runGit(addArgs);
  if (res.code !== 0) {
    const err = new Error(`git worktree add failed: ${res.stderr.trim()}`);
    (err as Error & { cause?: unknown }).cause = { kind: "git_state" };
    throw err;
  }

  log.info("worktree created", { path, branch });
  return { path, branch, is_throwaway: true };
}

/**
 * Remove a worktree. Best-effort and idempotent.
 *
 * @param handle The handle returned by create().
 * @param opts.keep If true, leaves the worktree on disk for inspection.
 * @returns true if removed, false if kept or not present.
 */
export async function destroy(
  handle: WorktreeHandle,
  opts?: { keep?: boolean },
): Promise<boolean> {
  if (opts?.keep) {
    log.info("worktree retained for inspection", { path: handle.path });
    return false;
  }
  if (!existsSync(handle.path)) return false;

  const remove = runGit(["worktree", "remove", "--force", handle.path]);
  if (remove.code !== 0) {
    log.warn("worktree remove failed; pruning anyway", { stderr: remove.stderr });
  }
  runGit(["worktree", "prune"]);

  if (handle.is_throwaway) {
    const del = runGit(["branch", "-D", handle.branch]);
    if (del.code !== 0) log.debug("branch delete returned non-zero", { stderr: del.stderr });
  }

  return true;
}

/**
 * List currently-known throwaway worktrees. Used by /codex:status and cleanup
 * sweeps. Returns paths only — caller can re-construct handles as needed.
 */
export async function listThrowaways(): Promise<string[]> {
  const list = runGit(["worktree", "list", "--porcelain"]);
  if (list.code !== 0) return [];
  const lines = list.stdout.split("\n");
  const root = worktreesRoot();
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      const p = line.slice("worktree ".length).trim();
      if (p.startsWith(root)) out.push(p);
    }
  }
  return out;
}
