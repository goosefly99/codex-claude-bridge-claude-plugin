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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

function registryPath(registry: Registry): string {
  const data =
    process.env["CLAUDE_PLUGIN_DATA"] ?? join(homedir(), ".claude", "plugin-data");
  return join(data, "codex-bridge", "jobs", workspaceHash(), `${registry}.json`);
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
