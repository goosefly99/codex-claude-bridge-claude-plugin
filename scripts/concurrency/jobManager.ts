/**
 * Job manager — dual-registry concurrency.
 *
 * Slash commands ("commands" registry): exactly ONE job runs at a time per
 * workspace, FIFO depth-1 queue. Subsequent enqueues are rejected.
 *
 * Delegator skill ("delegator" registry): N parallel jobs, capped at
 * `config.delegator_max_concurrent` (default 4). Used exclusively by
 * `scripts/codex/delegator.ts`.
 *
 * State persistence:
 *   ${CLAUDE_PLUGIN_DATA}/codex-bridge/jobs/<workspace-hash>/<registry>.json
 *
 * @module scripts/concurrency/jobManager
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

import { getConfig } from "../util/config.js";
import { getLogger } from "../util/log.js";

const log = getLogger("jobManager");

export type JobState = "idle" | "running" | "completed-pending-delivery";

export type Registry = "commands" | "delegator";

export interface JobDescriptor {
  id: string;
  command: string;
  workspace_hash: string;
  registry: Registry;
  state: JobState;
  started_at: string;
  completed_at: string | null;
  result: string | null;
  request_id?: string;
  error?: string;
}

export interface RegistrySnapshot {
  active: JobDescriptor[];
  queued: JobDescriptor[];
}

interface RegistryFile {
  active: JobDescriptor[];
  queued: JobDescriptor[];
}

const inflightControllers = new Map<string, AbortController>();

function workspaceHash(): string {
  return createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
}

function dataRoot(): string {
  return process.env["CLAUDE_PLUGIN_DATA"] ?? join(homedir(), ".claude", "plugin-data");
}

function registryPath(registry: Registry): string {
  return join(dataRoot(), "codex-bridge", "jobs", workspaceHash(), `${registry}.json`);
}

function resultsDir(): string {
  return join(dataRoot(), "codex-bridge", "results");
}

function resultPath(jobId: string): string {
  return join(resultsDir(), `${jobId}.json`);
}

function deliveredPath(jobId: string): string {
  return join(resultsDir(), `${jobId}.delivered`);
}

function readRegistry(registry: Registry): RegistryFile {
  const path = registryPath(registry);
  if (!existsSync(path)) return { active: [], queued: [] };
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as RegistryFile;
  } catch (err) {
    log.warn("registry file unreadable; resetting", {
      registry,
      err: String(err),
    });
    return { active: [], queued: [] };
  }
}

function writeRegistry(registry: Registry, file: RegistryFile): void {
  const path = registryPath(registry);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
}

function newJob(command: string, registry: Registry): JobDescriptor {
  return {
    id: randomUUID(),
    command,
    workspace_hash: workspaceHash(),
    registry,
    state: "running",
    started_at: new Date().toISOString(),
    completed_at: null,
    result: null,
  };
}

async function capacity(registry: Registry): Promise<number> {
  if (registry === "commands") return 1;
  const cfg = await getConfig();
  return cfg.delegator_max_concurrent;
}

export interface EnqueueOptions {
  registry?: Registry;
  mode?: "foreground" | "background";
  signal?: AbortSignal;
}

/**
 * Enqueue a new job in the given registry.
 */
export async function enqueue<T>(
  command: string,
  fn: (signal: AbortSignal) => Promise<T>,
  opts: EnqueueOptions = {},
): Promise<JobDescriptor> {
  const registry: Registry = opts.registry ?? "commands";
  const mode: "foreground" | "background" = opts.mode ?? "foreground";
  const cap = await capacity(registry);

  const file = readRegistry(registry);

  if (file.active.length >= cap) {
    if (registry === "commands") {
      if (file.queued.length >= 1) {
        throw new Error(
          "a job is already running and the queue is full; see /codex:status",
        );
      }
      const queued = newJob(command, registry);
      queued.state = "idle";
      file.queued.push(queued);
      writeRegistry(registry, file);
      log.info("queued behind active job", { id: queued.id, registry });
      return queued;
    }
    throw new Error(
      `delegator registry full at capacity ${cap}; wait or raise delegator_max_concurrent`,
    );
  }

  const job = newJob(command, registry);
  file.active.push(job);
  writeRegistry(registry, file);
  log.info("job started", { id: job.id, registry, command });

  const ctrl = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", () => ctrl.abort());
  }
  inflightControllers.set(job.id, ctrl);

  const run = (async (): Promise<void> => {
    try {
      const result = await fn(ctrl.signal);
      job.state = "completed-pending-delivery";
      job.completed_at = new Date().toISOString();
      job.result = typeof result === "string" ? result : JSON.stringify(result);
      log.info("job completed", { id: job.id, registry });
    } catch (err) {
      job.state = "completed-pending-delivery";
      job.completed_at = new Date().toISOString();
      job.error = err instanceof Error ? err.message : String(err);
      log.error("job failed", { id: job.id, registry, err: job.error });
    } finally {
      inflightControllers.delete(job.id);
      const updated = readRegistry(registry);
      const idx = updated.active.findIndex((j) => j.id === job.id);
      if (idx >= 0) updated.active[idx] = job;
      writeRegistry(registry, updated);
    }
  })();

  if (mode === "foreground") {
    await run;
  } else {
    run.catch(() => {
      /* errors already logged */
    });
  }

  return job;
}

/**
 * Snapshot of both registries combined. /codex:status renders this.
 */
export async function current(): Promise<{
  commands: RegistrySnapshot;
  delegator: RegistrySnapshot;
}> {
  const commands = readRegistry("commands");
  const delegator = readRegistry("delegator");
  return {
    commands: { active: commands.active, queued: commands.queued },
    delegator: { active: delegator.active, queued: delegator.queued },
  };
}

/**
 * Cancel the currently-running job, if any, in the given registry.
 */
export async function cancel(registry: Registry = "commands"): Promise<boolean> {
  const file = readRegistry(registry);
  if (file.active.length === 0) return false;
  let cancelled = 0;
  for (const j of file.active) {
    const ctrl = inflightControllers.get(j.id);
    if (ctrl) {
      ctrl.abort();
      inflightControllers.delete(j.id);
      cancelled += 1;
    }
  }
  file.active = [];
  writeRegistry(registry, file);
  return cancelled > 0;
}

/**
 * Cancel a specific job by id. Used by delegator to surgically abort a single
 * sub-job (e.g. an A/B branch was aborted by the user).
 */
export async function cancelById(id: string): Promise<boolean> {
  const ctrl = inflightControllers.get(id);
  if (!ctrl) return false;
  ctrl.abort();
  inflightControllers.delete(id);
  for (const reg of ["commands", "delegator"] as Registry[]) {
    const file = readRegistry(reg);
    const before = file.active.length;
    file.active = file.active.filter((j) => j.id !== id);
    if (file.active.length !== before) writeRegistry(reg, file);
  }
  return true;
}

/**
 * Spawn a detached child process that survives the parent's exit.
 *
 * The child's PID is written into the job record before this function
 * returns. On POSIX, `detached: true` starts a new session; `.unref()`
 * lets the event loop drain in the parent. On Windows, `windowsHide: true`
 * keeps the child from opening a console window.
 *
 * @param jobId  The already-registered job ID (used only for logging).
 * @param cmd    Executable to spawn (usually `process.execPath`).
 * @param args   Arguments forwarded to the child.
 * @param extraEnv  Additional environment variables merged into the child env.
 */
export function spawnDetached(
  jobId: string,
  cmd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): void {
  const child = spawn(cmd, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, ...extraEnv },
  });
  child.unref();
  log.info("detached child spawned", { jobId, pid: child.pid });
}

export interface JobResult {
  jobId: string;
  command: string;
  result?: unknown;
  error?: string;
  completed_at: string;
}

/**
 * Write the result of a detached background job to the results directory.
 * Called by CLI wrappers at the end of their run when CODEX_BRIDGE_JOB_ID
 * is present in the environment.
 */
export function writeJobResult(
  jobId: string,
  command: string,
  result: unknown,
  error?: string,
): void {
  const dir = resultsDir();
  mkdirSync(dir, { recursive: true });
  const envelope: JobResult = {
    jobId,
    command,
    completed_at: new Date().toISOString(),
    ...(error ? { error } : { result }),
  };
  writeFileSync(resultPath(jobId), JSON.stringify(envelope, null, 2), { mode: 0o600 });
  log.info("background job result written", { jobId });
}

/**
 * Read all job results that have not yet been delivered to the user.
 * `/codex:status` calls this and then marks each one as delivered.
 */
export function readUndeliveredResults(): JobResult[] {
  const dir = resultsDir();
  if (!existsSync(dir)) return [];
  const out: JobResult[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const jobId = entry.slice(0, -5);
    if (existsSync(deliveredPath(jobId))) continue;
    try {
      const raw = readFileSync(join(dir, entry), "utf-8");
      out.push(JSON.parse(raw) as JobResult);
    } catch {
      /* corrupt file — skip */
    }
  }
  return out;
}

/**
 * Mark a background job result as delivered so it is not surfaced again
 * by the next `/codex:status` call.
 */
export function markResultDelivered(jobId: string): void {
  const dir = resultsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(deliveredPath(jobId), "", { mode: 0o600 });
}
