/**
 * Standalone delegation engine — the `implement-with-codex` skill's transport.
 *
 * This module bypasses /codex:rescue and talks directly to
 * scripts/codex/transport.ts. It exposes:
 *   - delegate(plan, opts)          — single Codex sub-job
 *   - delegateParallel(tasks, opts) — N parallel sub-jobs
 *   - pattern(pid, input)           — high-level helper for P1/P3/P4/P5/P7
 *
 * Each sub-job is registered in the `delegator` registry of jobManager.ts,
 * which is separate from the slash-command depth-1 FIFO. The cap is
 * `config.delegator_max_concurrent` (default 4).
 *
 * Each mutating sub-job goes through a first-write confirmation gate unless
 * the caller passes `confirm: false`. Confirmation suppression is still logged
 * so an operator can audit later.
 *
 * @module scripts/codex/delegator
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { getConfig } from "../util/config.js";
import { getLogger } from "../util/log.js";
import { toUnixPath } from "../util/paths.js";
import { create as createWorktree, destroy as destroyWorktree } from "../git/worktree.js";
import type { WorktreeHandle } from "../git/worktree.js";
import { enqueue } from "../concurrency/jobManager.js";
import type { JobDescriptor } from "../concurrency/jobManager.js";

import { sendCompletion, type ChatMessage } from "./transport.js";
import { runAdversarialDiffReview, type AdversarialOutput } from "./adversarialEngine.js";

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = resolve(dirname(__filename), "..", "..");

const log = getLogger("delegator");

export interface DelegationResult {
  status: "completed" | "partial" | "error";
  summary: string;
  files_changed: Array<{ path: string; lines_added: number; lines_removed: number }>;
  diff_stat: { files: number; insertions: number; deletions: number };
  next_steps: string[];
  error?: string;
}

export type PatternId = "P1" | "P3" | "P4" | "P5" | "P7";

export interface DelegateOptions {
  /** Reasoning effort hint forwarded to Codex. Defaults to "medium". */
  effort?: "low" | "medium" | "high";
  /** Skip the first-write confirmation gate. Logged when set. */
  confirm?: boolean;
  /** Spawn the sub-job in a throwaway worktree. */
  isolate_worktrees?: boolean;
  /** Caller-supplied job label (for /codex:status). */
  label?: string;
  /** Tag the sub-job with the pattern that invoked it. */
  pattern?: PatternId;
}

export interface ParallelTask {
  plan: string;
  /** Optional per-task overrides. */
  options?: DelegateOptions;
  /** Optional label override. */
  label?: string;
}

let outputValidator: ((data: unknown) => boolean) | null = null;

function getOutputValidator(): (data: unknown) => boolean {
  if (outputValidator) return outputValidator;
  const schemaPath = resolve(PLUGIN_ROOT, "schemas", "delegator-output.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as object;
  const ajv = new (Ajv2020 as unknown as new (opts: object) => {
    compile(s: object): (data: unknown) => boolean;
  })({ allErrors: true, strict: false });
  (addFormats as unknown as (a: unknown) => void)(ajv);
  outputValidator = ajv.compile(schema);
  return outputValidator;
}

function loadSystemPrompt(): string {
  const path = resolve(PLUGIN_ROOT, "prompts", "delegator-system.md");
  return readFileSync(path, "utf-8");
}

function parseDelegationJson(text: string): DelegationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("delegator output was not JSON");
    parsed = JSON.parse(match[0]);
  }

  if (!getOutputValidator()(parsed)) {
    log.warn("delegator output failed schema validation; surfacing best-effort");
  }

  const result = parsed as DelegationResult;
  // Normalize paths to forward-slash form so downstream rendering is stable.
  if (Array.isArray(result.files_changed)) {
    result.files_changed = result.files_changed.map((f) => ({
      ...f,
      path: toUnixPath(f.path),
    }));
  }
  return result;
}

function buildUserMessage(plan: string, opts: DelegateOptions, cwd: string): string {
  const lines = [
    `Workspace: ${toUnixPath(cwd)}`,
    `Plan:`,
    "",
    plan,
    "",
    "Acceptance: produce the JSON envelope described in the system prompt. No prose.",
  ];
  if (opts.confirm === false) {
    lines.push("Confirmation gate: SUPPRESSED by caller. You may write without asking, but report every file you change.");
  } else {
    lines.push("Confirmation gate: ACTIVE. Wait for explicit confirmation before the first file mutation.");
  }
  if (opts.pattern) {
    lines.push(`Invoked under pattern ${opts.pattern}.`);
  }
  return lines.join("\n");
}

async function runOneDelegation(
  plan: string,
  opts: DelegateOptions,
  cwd: string,
): Promise<DelegationResult> {
  if (opts.confirm === false) {
    log.info("first-write confirmation gate suppressed by caller", {
      label: opts.label ?? "(none)",
      pattern: opts.pattern ?? "(none)",
    });
  }

  const messages: ChatMessage[] = [
    { role: "system", content: loadSystemPrompt() },
    { role: "user", content: buildUserMessage(plan, opts, cwd) },
  ];

  const completionOpts: Parameters<typeof sendCompletion>[1] = {
    response_format: { type: "json_object" },
  };
  if (opts.effort) completionOpts.reasoning_effort = opts.effort;

  const completion = await sendCompletion(messages, completionOpts);
  return parseDelegationJson(completion.message.content);
}

/**
 * Run a single Codex sub-job for the given plan.
 */
export async function delegate(
  plan: string,
  opts: DelegateOptions = {},
): Promise<DelegationResult> {
  if (typeof plan !== "string" || plan.trim().length === 0) {
    throw new Error("delegate(plan): plan must be a non-empty string");
  }

  const cfg = await getConfig();
  const isolate = opts.isolate_worktrees ?? cfg.delegator_isolate_worktrees;
  let worktree: WorktreeHandle | null = null;
  const cwd = process.cwd();

  if (isolate) {
    worktree = await createWorktree();
  }

  const label = opts.label ?? `delegate ${opts.pattern ?? "P1"}`;

  try {
    const job: JobDescriptor = await enqueue(
      label,
      async (_signal) => {
        const result = await runOneDelegation(plan, opts, worktree?.path ?? cwd);
        return JSON.stringify(result);
      },
      { registry: "delegator", mode: "foreground" },
    );

    if (job.error) {
      return {
        status: "error",
        summary: "delegation failed",
        files_changed: [],
        diff_stat: { files: 0, insertions: 0, deletions: 0 },
        next_steps: ["inspect logs at ${CLAUDE_PLUGIN_DATA}/codex-bridge/logs/"],
        error: job.error,
      };
    }

    if (!job.result) {
      return {
        status: "error",
        summary: "delegation returned no result",
        files_changed: [],
        diff_stat: { files: 0, insertions: 0, deletions: 0 },
        next_steps: [],
        error: "empty result payload",
      };
    }

    return JSON.parse(job.result) as DelegationResult;
  } finally {
    if (worktree) {
      await destroyWorktree(worktree).catch(() => {
        /* best-effort cleanup */
      });
    }
  }
}

/**
 * Run N tasks in parallel via the delegator registry.
 */
export async function delegateParallel(
  tasks: ParallelTask[],
  opts: DelegateOptions = {},
): Promise<DelegationResult[]> {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("delegateParallel(tasks): tasks must be a non-empty array");
  }
  const cfg = await getConfig();
  if (tasks.length > cfg.delegator_max_concurrent) {
    throw new Error(
      `delegateParallel: requested ${tasks.length} parallel sub-jobs but cap is ${cfg.delegator_max_concurrent}. Raise delegator_max_concurrent or queue tasks yourself.`,
    );
  }

  return Promise.all(
    tasks.map((t) =>
      delegate(t.plan, {
        ...opts,
        ...(t.options ?? {}),
        ...(t.label ? { label: t.label } : {}),
      }),
    ),
  );
}

// -----------------------------------------------------------------------------
// Pattern helpers — high-level recipes the skill cites by id.
// -----------------------------------------------------------------------------

export interface PatternInputP1 {
  plan: string;
  options?: DelegateOptions;
}

export interface PatternInputP3 {
  plan: string;
  max_iterations?: number;
  audit_gate?: "pass" | "needs-changes" | "blocker";
  options?: DelegateOptions;
}

export interface PatternInputP4 {
  plan: string;
  options?: DelegateOptions;
}

export interface PatternInputP5 {
  codex_share: string;
  claude_share: string; // documented for the caller; not used by the delegator
  options?: DelegateOptions;
}

export interface PatternInputP7 {
  initial_artifact: string;
  evaluate_prompt: string;
  max_iterations?: number;
  options?: DelegateOptions;
}

export type PatternInput =
  | { id: "P1"; input: PatternInputP1 }
  | { id: "P3"; input: PatternInputP3 }
  | { id: "P4"; input: PatternInputP4 }
  | { id: "P5"; input: PatternInputP5 }
  | { id: "P7"; input: PatternInputP7 };

export interface P3Result {
  iterations: DelegationResult[];
  final_audit: AdversarialOutput;
}

export interface P4Result {
  results: DelegationResult[];
}

export interface P7Result {
  iterations: Array<{ delegation: DelegationResult; audit: AdversarialOutput }>;
  terminated_reason: "audit_passed" | "max_iterations" | "error";
}

/**
 * Dispatch into one of the named patterns. The return shape depends on the
 * pattern; callers narrow via the id.
 */
export async function pattern(
  id: "P1",
  input: PatternInputP1,
): Promise<DelegationResult>;
export async function pattern(id: "P3", input: PatternInputP3): Promise<P3Result>;
export async function pattern(id: "P4", input: PatternInputP4): Promise<P4Result>;
export async function pattern(
  id: "P5",
  input: PatternInputP5,
): Promise<DelegationResult>;
export async function pattern(id: "P7", input: PatternInputP7): Promise<P7Result>;
export async function pattern(
  id: PatternId,
  input: unknown,
): Promise<DelegationResult | P3Result | P4Result | P7Result> {
  switch (id) {
    case "P1": {
      const p = input as PatternInputP1;
      return delegate(p.plan, { ...(p.options ?? {}), pattern: "P1" });
    }
    case "P3": {
      const p = input as PatternInputP3;
      const cap = p.max_iterations ?? 3;
      const gate = p.audit_gate ?? "pass";
      const iterations: DelegationResult[] = [];
      let lastAudit: AdversarialOutput = {
        verdict: "needs-changes",
        severity_buckets: { critical: [], high: [], medium: [], low: [] },
        next_steps: [],
        safe_to_ship: [],
      };
      let currentPlan = p.plan;
      for (let i = 0; i < cap; i++) {
        const result = await delegate(currentPlan, {
          ...(p.options ?? {}),
          pattern: "P3",
          label: `P3 iter ${i + 1}`,
        });
        iterations.push(result);
        lastAudit = await runAdversarialDiffReview(undefined, { effort: "high" });
        if (lastAudit.verdict === gate || lastAudit.verdict === "pass") break;
        currentPlan = repromptFromAudit(p.plan, lastAudit);
      }
      return { iterations, final_audit: lastAudit };
    }
    case "P4": {
      const p = input as PatternInputP4;
      // Two parallel Codex agents (the "Claude" slot is the caller's own work).
      const results = await delegateParallel(
        [
          { plan: p.plan, label: "P4 codex-a" },
          { plan: p.plan, label: "P4 codex-b" },
        ],
        { ...(p.options ?? {}), pattern: "P4", isolate_worktrees: true },
      );
      return { results };
    }
    case "P5": {
      const p = input as PatternInputP5;
      return delegate(p.codex_share, { ...(p.options ?? {}), pattern: "P5" });
    }
    case "P7": {
      const p = input as PatternInputP7;
      const cap = p.max_iterations ?? 5;
      const iters: Array<{ delegation: DelegationResult; audit: AdversarialOutput }> = [];
      let plan = p.initial_artifact;
      let reason: P7Result["terminated_reason"] = "max_iterations";
      for (let i = 0; i < cap; i++) {
        const d = await delegate(plan, {
          ...(p.options ?? {}),
          pattern: "P7",
          label: `P7 iter ${i + 1}`,
        });
        if (d.status === "error") {
          iters.push({
            delegation: d,
            audit: emptyAudit(),
          });
          reason = "error";
          break;
        }
        const audit = await runAdversarialDiffReview(undefined, {
          effort: "high",
          steering: p.evaluate_prompt,
        });
        iters.push({ delegation: d, audit });
        if (audit.verdict === "pass") {
          reason = "audit_passed";
          break;
        }
        plan = repromptFromAudit(p.initial_artifact, audit);
      }
      return { iterations: iters, terminated_reason: reason };
    }
    default: {
      const _exhaustive: never = id;
      throw new Error(`unknown pattern: ${_exhaustive}`);
    }
  }
}

function repromptFromAudit(originalPlan: string, audit: AdversarialOutput): string {
  const lines = [
    "Continuing work. The previous iteration's adversarial audit produced the following findings:",
    "",
  ];
  for (const sev of ["critical", "high", "medium", "low"] as const) {
    const bucket = audit.severity_buckets[sev];
    if (bucket.length === 0) continue;
    lines.push(`### ${sev}`);
    for (const issue of bucket) {
      lines.push(`- ${issue.file}:${issue.line} [${issue.surface}] ${issue.description}`);
      lines.push(`  fix hint: ${issue.fix_hint}`);
    }
    lines.push("");
  }
  if (audit.next_steps.length > 0) {
    lines.push("Next steps from the audit:");
    for (const s of audit.next_steps) lines.push(`- ${s}`);
    lines.push("");
  }
  lines.push("Original plan (for reference):");
  lines.push(originalPlan);
  return lines.join("\n");
}

function emptyAudit(): AdversarialOutput {
  return {
    verdict: "needs-changes",
    severity_buckets: { critical: [], high: [], medium: [], low: [] },
    next_steps: [],
    safe_to_ship: [],
  };
}
