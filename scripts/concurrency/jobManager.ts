/**
 * Job manager — single in-flight Codex job per workspace, FIFO depth-1 queue.
 *
 * Hard invariant (DI-10): exactly ONE job runs at a time per workspace. A
 * second invocation queues at depth 1; a third is rejected with a clear error
 * pointing the user at /codex:status. This is deliberate v1 simplicity; v2
 * may relax the constraint after we have usage data.
 *
 * State persistence:
 *   ${CLAUDE_PLUGIN_DATA}/codex-bridge/jobs/<workspace-hash>/active.json
 *
 * Auto-delivery: when a background job completes, we surface the result back
 * into the originating Claude Code session as a tool-result message. If the
 * session has ended, the result persists in logs/ for next-session retrieval.
 *
 * @module scripts/concurrency/jobManager
 */

/** Job lifecycle state. Strict ordering: idle -> running -> completed-pending-delivery. */
export type JobState =
  | "idle"
  | "running"
  | "completed-pending-delivery";

/** A queued or active job descriptor. */
export interface JobDescriptor {
  /** Stable job ID (UUID). */
  id: string;
  /** Human-readable command label, e.g. "/codex:adversarial-review main..HEAD". */
  command: string;
  /** Hashed workspace path (job registry key). */
  workspace_hash: string;
  /** Current lifecycle state. */
  state: JobState;
  /** ISO 8601 start timestamp. */
  started_at: string;
  /** ISO 8601 completion timestamp; null while running. */
  completed_at: string | null;
  /** Result payload (string for prose; serialized JSON for adversarial). */
  result: string | null;
  /** Optional Codex provider request ID for observability. */
  request_id?: string;
}

/** Snapshot returned by current() — strictly read-only view. */
export interface RegistrySnapshot {
  active: JobDescriptor | null;
  queued: JobDescriptor[];
}

/**
 * Enqueue a new job. If the registry is idle, the job runs immediately. If
 * a job is already running, the new job is queued (depth 1). If the queue is
 * already full, throws with a hint to /codex:status.
 *
 * The fn is invoked in a detached worker (background) or inline (foreground)
 * depending on `mode`. On completion the registry is updated and the result
 * is delivered as a tool-result message in the originating session.
 *
 * @param command Human-readable command label for /codex:status display.
 * @param fn Async function that performs the actual Codex work.
 * @param mode "foreground" blocks the caller; "background" returns immediately.
 * @returns A JobDescriptor (already populated with id and started_at).
 * @throws Error with message including "queued" or "rejected" on conflicts.
 */
export async function enqueue<T>(
  _command: string,
  _fn: () => Promise<T>,
  _mode: "foreground" | "background",
): Promise<JobDescriptor> {
  throw new Error("not implemented");
}

/**
 * Read the current registry state. Used by /codex:status. Read-only; never
 * mutates state. Returns a deep-cloned snapshot so the caller can't
 * accidentally corrupt the registry by mutating fields.
 *
 * @returns A RegistrySnapshot.
 */
export async function current(): Promise<RegistrySnapshot> {
  throw new Error("not implemented");
}

/**
 * Cancel the currently-running job, if any. Sends an AbortSignal to the
 * underlying transport and clears the registry slot. Idempotent.
 *
 * v1 does not expose a user-facing /codex:cancel command, but this entry
 * point is used internally for cleanup on session shutdown.
 *
 * @returns true if a job was cancelled; false if registry was idle.
 */
export async function cancel(): Promise<boolean> {
  throw new Error("not implemented");
}
