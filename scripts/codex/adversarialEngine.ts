/**
 * Adversarial review engine — the orchestrator that powers the four codex
 * review commands: /codex:diff-review, /codex:adversarial-diff-review,
 * /codex:review, and /codex:adversarial-review. The diff variants use the
 * 6-phase pipeline (parseArguments → resolveTarget → collectContext →
 * buildPrompt → dispatchAndValidate). The general variants share the locked
 * system prompts and JSON output schema but assemble their input via
 * scripts/codex/fsContext.collectFilesystemContext instead of a git diff.
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
import { collectFilesystemContext, type CollectedContext } from "./fsContext.js";
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

/**
 * Run the adversarial review against the working diff (or an explicit ref/refspec).
 *
 * This is the engine for `/codex:adversarial-diff-review`. For arbitrary
 * filesystem content (folder, single file) use `runGeneralAdversarialReview`.
 */
export async function runAdversarialDiffReview(
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
 * Run a neutral (non-adversarial) code review against the working diff (or an
 * explicit ref/refspec) using `prompts/review-system.md`. Returns prose rather
 * than structured JSON. Engine for `/codex:diff-review`.
 */
export async function runDiffReview(
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

export interface GeneralReviewOptions {
  effort?: "low" | "medium" | "high";
  background?: boolean;
  wait?: boolean;
  /** User-supplied question or focus area, included in the user prompt preamble. */
  question?: string;
  /** Adversarial-only: narrow reasoning to a single attack surface. */
  focus?: AttackSurface;
  /** Override the resolution root passed to collectFilesystemContext (tests). */
  root?: string;
}

function renderFilesystemContext(ctx: CollectedContext): string {
  const lines: string[] = [];
  lines.push(`Filesystem content under review (${ctx.files.length} files, ~${ctx.totalTokens} tokens):`);
  for (const f of ctx.files) {
    lines.push("");
    lines.push(`### ${f.relPath}`);
    lines.push("```");
    lines.push(f.content);
    lines.push("```");
  }
  if (ctx.truncated || ctx.skipped.length > 0) {
    lines.push("");
    lines.push("The following paths were skipped or truncated:");
    for (const s of ctx.skipped) lines.push(`- ${s}`);
    if (ctx.truncated) {
      lines.push("");
      lines.push(
        "The token budget was exhausted. Findings should reflect that the model only saw the files listed above.",
      );
    }
  }
  return lines.join("\n");
}

const GENERAL_REVIEW_FRAMING =
  "You are reviewing arbitrary filesystem content (files and/or folders the user pointed at) — NOT a git diff. There is no base/head pair. Treat the supplied content as the full body of code or text to consider.";

/**
 * Run a neutral review against arbitrary files and folders. Engine for
 * `/codex:review` when called with one or more `<path>` arguments.
 */
export async function runGeneralReview(
  paths: string[],
  opts: GeneralReviewOptions = {},
): Promise<string> {
  if (paths.length === 0) {
    throw new Error(
      "runGeneralReview requires at least one path; for diff review use runDiffReview / /codex:diff-review",
    );
  }
  const effort = opts.effort ?? "medium";
  const fsOpts: Parameters<typeof collectFilesystemContext>[1] = opts.root ? { root: opts.root } : {};
  const ctx = await collectFilesystemContext(paths, fsOpts);
  if (ctx.files.length === 0) {
    throw new Error(
      `no reviewable files found under: ${paths.join(", ")} (all entries were ignored, binary, or empty)`,
    );
  }
  const systemPath = resolve(PLUGIN_ROOT, "prompts", "review-system.md");
  const system = readFileSync(systemPath, "utf-8");
  const lines: string[] = [GENERAL_REVIEW_FRAMING, ""];
  if (opts.question) {
    lines.push("User's question / focus:");
    lines.push(opts.question);
    lines.push("");
  }
  lines.push(renderFilesystemContext(ctx));
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: lines.join("\n") },
  ];
  log.debug("dispatching general review", {
    paths: paths.length,
    files: ctx.files.length,
    tokens: ctx.totalTokens,
    truncated: ctx.truncated,
  });
  const result = await sendCompletion(messages, { reasoning_effort: effort });
  return result.message.content;
}

/**
 * Run the adversarial 7-attack-surface review against arbitrary files and
 * folders. Engine for `/codex:adversarial-review` when called with one or more
 * `<path>` arguments. Loads the same locked `prompts/adversarial-system.md`
 * and validates output against `schemas/adversarial-output.json`.
 */
export async function runGeneralAdversarialReview(
  paths: string[],
  opts: GeneralReviewOptions = {},
): Promise<AdversarialOutput> {
  if (paths.length === 0) {
    throw new Error(
      "runGeneralAdversarialReview requires at least one path; for diff review use runAdversarialDiffReview / /codex:adversarial-diff-review",
    );
  }
  if (opts.focus && !ATTACK_SURFACES.includes(opts.focus)) {
    throw new Error(
      `unknown --focus surface "${opts.focus}". Valid: ${ATTACK_SURFACES.join(", ")}`,
    );
  }
  const fsOpts: Parameters<typeof collectFilesystemContext>[1] = opts.root ? { root: opts.root } : {};
  const ctx = await collectFilesystemContext(paths, fsOpts);
  if (ctx.files.length === 0) {
    throw new Error(
      `no reviewable files found under: ${paths.join(", ")} (all entries were ignored, binary, or empty)`,
    );
  }

  const system = loadSystemPrompt();
  const lines: string[] = [GENERAL_REVIEW_FRAMING, ""];
  if (opts.question) {
    lines.push("Steering directive from the user:");
    lines.push(opts.question);
    lines.push("");
  }
  if (opts.focus) {
    lines.push(
      `Narrow your reasoning to the "${opts.focus}" attack surface for this review. Other surfaces may still produce findings, but spend the bulk of your reasoning here.`,
    );
    lines.push("");
  }
  lines.push(renderFilesystemContext(ctx));

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: lines.join("\n") },
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
