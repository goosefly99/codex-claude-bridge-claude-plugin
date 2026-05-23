/**
 * Adversarial review engine — the 6-phase orchestrator that powers
 * /codex:adversarial-review.
 *
 * Hard invariants:
 *   - The 7 attack surfaces are loaded VERBATIM from
 *     prompts/adversarial-system.md. They are NEVER generated dynamically.
 *     tests/anti-drift.test.ts enforces this.
 *   - Output is structured JSON validated against
 *     schemas/adversarial-output.json. Free-form prose is a regression.
 *
 * @module scripts/codex/adversarialEngine
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { getConfig } from "../util/config.js";
import { getLogger } from "../util/log.js";
import { toUnixPath } from "../util/paths.js";
import { prepareReviewBase, cleanupReviewBase } from "../git/greenfield.js";

import { classifyDiff } from "./sizeClassifier.js";
import { sendCompletion, type ChatMessage } from "./transport.js";

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = resolve(dirname(__filename), "..", "..");

const log = getLogger("adversarialEngine");

export enum AdversarialPhase {
  ARGUMENT_PARSING = 1,
  SIZE_ESTIMATION = 2,
  TARGET_RESOLUTION = 3,
  CONTEXT_COLLECTION = 4,
  PROMPT_CONSTRUCTION = 5,
  DISPATCH_AND_VALIDATE = 6,
}

export const ATTACK_SURFACES = [
  "Authentication",
  "Data loss",
  "Rollbacks",
  "Race conditions",
  "Degraded dependencies",
  "Version skew",
  "Observability gaps",
] as const;

export type AttackSurface = (typeof ATTACK_SURFACES)[number];

export interface AdversarialIssue {
  file: string;
  line: number;
  surface: AttackSurface;
  description: string;
  fix_hint: string;
}

export interface AdversarialOutput {
  verdict: "pass" | "needs-changes" | "blocker";
  severity_buckets: {
    critical: AdversarialIssue[];
    high: AdversarialIssue[];
    medium: AdversarialIssue[];
    low: AdversarialIssue[];
  };
  next_steps: string[];
  safe_to_ship: string[];
}

export interface AdversarialOptions {
  effort?: "low" | "medium" | "high";
  focus?: AttackSurface;
  background?: boolean;
  wait?: boolean;
  steering?: string;
}

function loadSystemPrompt(): string {
  const path = resolve(PLUGIN_ROOT, "prompts", "adversarial-system.md");
  return readFileSync(path, "utf-8");
}

function loadOutputSchema(): object {
  const path = resolve(PLUGIN_ROOT, "schemas", "adversarial-output.json");
  return JSON.parse(readFileSync(path, "utf-8")) as object;
}

let validator: ((data: unknown) => boolean) | null = null;
let validatorErrors: unknown = null;

function getValidator(): (data: unknown) => boolean {
  if (validator) return validator;
  const ajv = new (Ajv2020 as unknown as new (opts: object) => {
    compile(s: object): ((data: unknown) => boolean) & { errors?: unknown };
  })({ allErrors: true, strict: false });
  (addFormats as unknown as (a: unknown) => void)(ajv);
  const compiled = ajv.compile(loadOutputSchema());
  validator = (data: unknown) => {
    const ok = compiled(data);
    validatorErrors = compiled.errors;
    return ok;
  };
  return validator;
}

function runGit(args: string[]): string {
  const res = spawnSync("git", args, { encoding: "utf-8" });
  if (res.status !== 0) {
    const err = new Error(`git ${args.join(" ")} failed: ${res.stderr?.trim() ?? ""}`);
    (err as Error & { cause?: unknown }).cause = { kind: "git_state" };
    throw err;
  }
  return res.stdout ?? "";
}

function approximateTokens(text: string): number {
  // Rough English ≈ 4 chars/token. Cheap, deterministic, no tiktoken dep.
  return Math.ceil(text.length / 4);
}

export function parseArguments(
  target: string | undefined,
  opts: AdversarialOptions | undefined,
): AdversarialOptions & { target: string | undefined } {
  const merged: AdversarialOptions & { target: string | undefined } = {
    effort: opts?.effort ?? "high",
    ...(opts?.focus ? { focus: opts.focus } : {}),
    ...(opts?.background ? { background: true } : {}),
    ...(opts?.wait ? { wait: true } : {}),
    ...(opts?.steering ? { steering: opts.steering } : {}),
    target,
  };
  if (merged.focus && !ATTACK_SURFACES.includes(merged.focus)) {
    throw new Error(
      `unknown --focus surface "${merged.focus}". Valid: ${ATTACK_SURFACES.join(", ")}`,
    );
  }
  return merged;
}

export async function estimateSize(target: string): Promise<"sync" | "background"> {
  return classifyDiff(target);
}

export async function resolveTarget(
  target: string | undefined,
): Promise<{ base: string; head: string; throwaway?: string }> {
  const base = await prepareReviewBase();
  if (target) {
    return { base: target.split("..")[0] ?? base.base, head: target.split("..")[1] ?? base.head };
  }
  const out: { base: string; head: string; throwaway?: string } = {
    base: base.base,
    head: base.head,
  };
  if (base.throwaway_ref) out.throwaway = base.throwaway_ref;
  return out;
}

export async function collectContext(targetRefs: {
  base: string;
  head: string;
}): Promise<{ diff: string; files: Map<string, string> }> {
  const cfg = await getConfig();
  const range =
    targetRefs.base === "HEAD" && targetRefs.head === "HEAD"
      ? []
      : [`${targetRefs.base}..${targetRefs.head}`];
  const diff = runGit(["diff", "--unified=3", ...range]);
  const files = new Map<string, string>();
  let used = approximateTokens(diff);

  if (used > cfg.context_token_budget) {
    const truncated = diff.slice(0, cfg.context_token_budget * 4);
    return { diff: truncated + "\n\n[... truncated ...]", files };
  }
  return { diff, files };
}

export async function buildPrompt(
  ctx: { diff: string; files: Map<string, string> },
  opts: AdversarialOptions,
): Promise<{ system: string; user: string }> {
  const system = loadSystemPrompt();
  const lines: string[] = [];
  if (opts.steering) {
    lines.push("Steering directive from the user:");
    lines.push(opts.steering);
    lines.push("");
  }
  if (opts.focus) {
    lines.push(
      `Narrow your reasoning to the "${opts.focus}" attack surface for this review. Other surfaces may still produce findings, but spend the bulk of your reasoning here.`,
    );
    lines.push("");
  }
  lines.push("Diff under review:");
  lines.push("```diff");
  lines.push(ctx.diff);
  lines.push("```");
  if (ctx.files.size > 0) {
    lines.push("");
    lines.push("Selected file contents:");
    for (const [p, content] of ctx.files) {
      lines.push(`### ${toUnixPath(p)}`);
      lines.push("```");
      lines.push(content);
      lines.push("```");
    }
  }
  return { system, user: lines.join("\n") };
}

export async function dispatchAndValidate(
  prompt: { system: string; user: string },
  opts: AdversarialOptions,
): Promise<AdversarialOutput> {
  const messages: ChatMessage[] = [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ];
  const completionOpts: Parameters<typeof sendCompletion>[1] = {
    response_format: { type: "json_object" },
  };
  if (opts.effort) completionOpts.reasoning_effort = opts.effort;
  const completion = await sendCompletion(messages, completionOpts);

  let parsed: unknown;
  try {
    parsed = JSON.parse(completion.message.content);
  } catch (err) {
    log.warn("model returned non-JSON; attempting tolerant recovery", { err: String(err) });
    parsed = recoverPartial(completion.message.content);
  }

  const ok = getValidator()(parsed);
  if (!ok) {
    log.warn("model output failed schema validation; surfacing best-effort", {
      errors: validatorErrors,
    });
  }
  return parsed as AdversarialOutput;
}

function recoverPartial(text: string): AdversarialOutput {
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]) as AdversarialOutput;
    } catch {
      /* fall through */
    }
  }
  return {
    verdict: "needs-changes",
    severity_buckets: { critical: [], high: [], medium: [], low: [] },
    next_steps: [
      "Model output was not valid JSON; treat raw response as advisory and re-run with --effort high.",
    ],
    safe_to_ship: [],
  };
}

export async function runAdversarialReview(
  target?: string,
  opts?: AdversarialOptions,
): Promise<AdversarialOutput> {
  const parsed = parseArguments(target, opts);
  const refs = await resolveTarget(parsed.target);
  try {
    const ctx = await collectContext({ base: refs.base, head: refs.head });
    const prompt = await buildPrompt(ctx, parsed);
    const result = await dispatchAndValidate(prompt, parsed);
    return result;
  } finally {
    if (refs.throwaway) {
      await cleanupReviewBase(refs.throwaway).catch(() => {
        /* best-effort */
      });
    }
  }
}

/**
 * Run a neutral (non-adversarial) code review using `prompts/review-system.md`.
 * Returns prose rather than structured JSON.
 */
export async function runNeutralReview(
  target?: string,
  opts?: Pick<AdversarialOptions, "effort" | "background" | "wait" | "steering">,
): Promise<string> {
  const effort = opts?.effort ?? "medium";
  const refs = await resolveTarget(target);
  try {
    const ctx = await collectContext({ base: refs.base, head: refs.head });
    const systemPath = resolve(PLUGIN_ROOT, "prompts", "review-system.md");
    const system = readFileSync(systemPath, "utf-8");
    const lines: string[] = [];
    if (opts?.steering) {
      lines.push("Steering directive from the user:");
      lines.push(opts.steering);
      lines.push("");
    }
    lines.push("Diff under review:");
    lines.push("```diff");
    lines.push(ctx.diff);
    lines.push("```");
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: lines.join("\n") },
    ];
    const result = await sendCompletion(messages, { reasoning_effort: effort });
    return result.message.content;
  } finally {
    if (refs.throwaway) {
      await cleanupReviewBase(refs.throwaway).catch(() => {
        /* best-effort */
      });
    }
  }
}
