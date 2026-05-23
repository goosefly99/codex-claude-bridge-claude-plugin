/**
 * Plan-stage adversarial reviewer — powers the `adversarial-plan-review` skill.
 *
 * This module runs Mark Kashef's adversarial planning loop: take a written
 * PLAN (not code), hand it to Codex with a locked system prompt, and iterate
 * up to a configurable cap (default 3) or until severity decreases
 * monotonically. The output is a structured JSON envelope with six gap
 * categories — distinct from the 7-attack-surface CODE taxonomy in
 * `adversarialEngine.ts`.
 *
 * Hard invariants:
 *   - The six gap categories are loaded VERBATIM from
 *     `prompts/plan-review-system.md`. They are NEVER generated dynamically.
 *     `tests/plan-reviewer.test.ts` enforces this.
 *   - Output is structured JSON validated against
 *     `schemas/plan-review-output.json`. Free-form prose is a regression.
 *   - The loop cap defaults to 3 and MUST NOT be raised silently.
 *
 * @module scripts/codex/planReviewer
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { getLogger } from "../util/log.js";

import { sendCompletion, type ChatMessage } from "./transport.js";

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = resolve(dirname(__filename), "..", "..");

const log = getLogger("planReviewer");

/**
 * The six gap categories the plan reviewer reasons through, in order. These
 * are hard-coded and must match `prompts/plan-review-system.md` and
 * `schemas/plan-review-output.json` verbatim. The anti-drift test in
 * `tests/plan-reviewer.test.ts` enforces this.
 */
export const PLAN_REVIEW_CATEGORIES = [
  "missing-requirement",
  "hidden-assumption",
  "scope-creep",
  "security-blind-spot",
  "integration-gap",
  "observability-gap",
] as const;

export type PlanReviewCategory = (typeof PLAN_REVIEW_CATEGORIES)[number];

/** A single gap identified by the plan reviewer. */
export interface PlanReviewGap {
  category: PlanReviewCategory;
  description: string;
  impact: string;
  mitigation: string;
}

/** Structured output of a single plan-review pass. */
export interface PlanReviewOutput {
  verdict: "acceptable" | "needs-revision" | "unfit";
  severity_score: number;
  gaps: PlanReviewGap[];
  out_of_scope_validated: string[];
  next_revision_hints: string[];
}

/** Options for a single-pass plan review. */
export interface PlanReviewOptions {
  /** Reasoning effort hint forwarded to Codex. Defaults to "high". */
  effort?: "low" | "medium" | "high";
  /** Narrow the review to one gap category. */
  focus?: PlanReviewCategory;
  /** Optional user directive prepended to the user message. */
  steering?: string;
}

/** Options for the iterative plan-review loop. */
export interface PlanReviewLoopOptions extends PlanReviewOptions {
  /** Maximum loop iterations. Defaults to 3 and MUST NOT be raised silently. */
  max_iterations?: number;
  /** If true, an "acceptable" verdict at any iteration ends the loop early. */
  stop_when_acceptable?: boolean;
}

/** A single iteration captured by the loop: the plan reviewed and its review. */
export interface PlanReviewLoopIteration {
  iteration: number;
  plan: string;
  review: PlanReviewOutput;
}

/** Final result of the plan-review loop, including termination reason. */
export interface PlanReviewLoopResult {
  iterations: PlanReviewLoopIteration[];
  terminated_reason:
    | "verdict_acceptable"
    | "severity_converged"
    | "max_iterations"
    | "unfit_short_circuit";
}

/** Tolerance (in severity points) for declaring the loop converged. */
const SEVERITY_CONVERGENCE_TOLERANCE = 5;

/** Hard default cap for loop iterations; do NOT silently raise. */
const DEFAULT_MAX_ITERATIONS = 3;

let cachedValidator: ((data: unknown) => boolean) | null = null;
let cachedValidatorErrors: unknown = null;

function loadSystemPrompt(): string {
  const path = resolve(PLUGIN_ROOT, "prompts", "plan-review-system.md");
  return readFileSync(path, "utf-8");
}

function loadOutputSchema(): object {
  const path = resolve(PLUGIN_ROOT, "schemas", "plan-review-output.json");
  return JSON.parse(readFileSync(path, "utf-8")) as object;
}

function getValidator(): (data: unknown) => boolean {
  if (cachedValidator) return cachedValidator;
  const ajv = new (Ajv2020 as unknown as new (opts: object) => {
    compile(s: object): ((data: unknown) => boolean) & { errors?: unknown };
  })({ allErrors: true, strict: false });
  (addFormats as unknown as (a: unknown) => void)(ajv);
  const compiled = ajv.compile(loadOutputSchema());
  cachedValidator = (data: unknown): boolean => {
    const ok = compiled(data);
    cachedValidatorErrors = compiled.errors;
    return ok;
  };
  return cachedValidator;
}

function buildUserMessage(planText: string, opts: PlanReviewOptions): string {
  const lines: string[] = [];
  if (opts.steering) {
    lines.push("Steering directive from the user:");
    lines.push(opts.steering);
    lines.push("");
  }
  if (opts.focus) {
    lines.push(
      `Narrow your reasoning to the "${opts.focus}" gap category for this review. Other categories may still produce findings, but spend the bulk of your reasoning here.`,
    );
    lines.push("");
  }
  lines.push("Plan under review:");
  lines.push("");
  lines.push(planText);
  lines.push("");
  lines.push(
    "Emit the JSON envelope described in the system prompt. No prose, no markdown fences.",
  );
  return lines.join("\n");
}

function recoverPartial(text: string): PlanReviewOutput {
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]) as PlanReviewOutput;
    } catch {
      /* fall through to a safe default */
    }
  }
  return {
    verdict: "needs-revision",
    severity_score: 50,
    gaps: [],
    out_of_scope_validated: [],
    next_revision_hints: [
      "Model output was not valid JSON; treat raw response as advisory and re-run with --effort high.",
    ],
  };
}

function parseAndValidate(rawContent: string): PlanReviewOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch (err) {
    log.warn("model returned non-JSON; attempting tolerant recovery", {
      err: String(err),
    });
    parsed = recoverPartial(rawContent);
  }

  const ok = getValidator()(parsed);
  if (!ok) {
    log.warn("model output failed schema validation; surfacing best-effort", {
      errors: cachedValidatorErrors,
    });
  }
  return parsed as PlanReviewOutput;
}

/**
 * Run a single adversarial review pass against the provided plan text.
 *
 * Loads the locked system prompt verbatim, dispatches a single
 * `sendCompletion` call with `response_format: json_object`, and validates
 * the result against `schemas/plan-review-output.json`. Validation failures
 * are logged as warnings and the best-effort parse is surfaced — same
 * pattern as `adversarialEngine.dispatchAndValidate`.
 *
 * @param planText The written plan to review. Must be a non-empty string.
 * @param opts Optional reasoning effort, focus category, and steering directive.
 * @returns The structured plan-review output.
 */
export async function runPlanReview(
  planText: string,
  opts: PlanReviewOptions = {},
): Promise<PlanReviewOutput> {
  if (typeof planText !== "string" || planText.trim().length === 0) {
    throw new Error("runPlanReview(planText): plan must be a non-empty string");
  }
  if (opts.focus && !PLAN_REVIEW_CATEGORIES.includes(opts.focus)) {
    throw new Error(
      `unknown --focus category "${opts.focus}". Valid: ${PLAN_REVIEW_CATEGORIES.join(", ")}`,
    );
  }

  const messages: ChatMessage[] = [
    { role: "system", content: loadSystemPrompt() },
    { role: "user", content: buildUserMessage(planText, opts) },
  ];

  const completionOpts: Parameters<typeof sendCompletion>[1] = {
    response_format: { type: "json_object" },
    reasoning_effort: opts.effort ?? "high",
  };

  log.debug("dispatching plan review", {
    plan_chars: planText.length,
    effort: completionOpts.reasoning_effort,
    focus: opts.focus ?? "(none)",
  });

  const completion = await sendCompletion(messages, completionOpts);
  return parseAndValidate(completion.message.content);
}

function buildRevisionUserMessage(
  previousPlan: string,
  review: PlanReviewOutput,
): string {
  const lines: string[] = [
    "You wrote a plan that just received an adversarial review. Produce a REVISED plan that addresses each gap below, OR explicitly declares it out-of-scope with a one-sentence justification.",
    "",
    "Previous plan:",
    "",
    previousPlan,
    "",
    `Previous severity_score: ${String(review.severity_score)}. Previous verdict: ${review.verdict}.`,
    "",
    "Gaps to address in the revision:",
  ];
  for (const gap of review.gaps) {
    lines.push(`- [${gap.category}] ${gap.description}`);
    lines.push(`  impact: ${gap.impact}`);
    lines.push(`  mitigation: ${gap.mitigation}`);
  }
  if (review.next_revision_hints.length > 0) {
    lines.push("");
    lines.push("Reviewer's next-revision hints:");
    for (const h of review.next_revision_hints) lines.push(`- ${h}`);
  }
  lines.push("");
  lines.push(
    "Output the REVISED plan as plain prose / markdown. Do NOT emit a JSON envelope — this step is plan text, not a review. Keep the structure the user originally provided where it still applies.",
  );
  return lines.join("\n");
}

/**
 * Ask Codex to produce a revised plan that addresses the prior review.
 *
 * This is a small dispatch (effort=medium) intentionally distinct from the
 * locked review prompt — we do NOT want the reviewer evaluating its own
 * revision. The revision is plain prose; only the review step emits JSON.
 *
 * @param previousPlan The plan text from the previous iteration.
 * @param review The previous iteration's structured review.
 * @returns The revised plan text.
 */
async function produceRevisedPlan(
  previousPlan: string,
  review: PlanReviewOutput,
): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are revising a plan in response to an adversarial review. Produce the revised plan only — no commentary, no JSON envelope, no preamble. Keep the original plan's structure where it still applies; integrate the reviewer's gaps as concrete plan items or as an explicit out-of-scope declaration with justification.",
    },
    { role: "user", content: buildRevisionUserMessage(previousPlan, review) },
  ];

  log.debug("dispatching plan revision", {
    previous_plan_chars: previousPlan.length,
    gap_count: review.gaps.length,
    previous_severity: review.severity_score,
  });

  const completion = await sendCompletion(messages, {
    reasoning_effort: "medium",
  });
  return completion.message.content;
}

/**
 * Run the iterative adversarial planning loop on the initial plan.
 *
 * The loop runs up to `max_iterations` (default 3). Each iteration:
 *   1. Runs `runPlanReview` on the current plan.
 *   2. If the verdict is `acceptable` and `stop_when_acceptable` is true,
 *      terminate with `verdict_acceptable`.
 *   3. If the verdict is `unfit`, terminate immediately with
 *      `unfit_short_circuit` — another revision pass will not help.
 *   4. If the severity_score did not drop by more than
 *      SEVERITY_CONVERGENCE_TOLERANCE (5) versus the previous iteration,
 *      terminate with `severity_converged`.
 *   5. Otherwise produce a revised plan and continue.
 *
 * Termination reason `max_iterations` means the loop hit the cap without
 * either an acceptable verdict, an unfit short-circuit, or severity
 * convergence.
 *
 * @param initialPlan The first plan to review. Must be a non-empty string.
 * @param opts Loop and per-iteration review options.
 * @returns The full iteration trace and the termination reason.
 */
export async function runPlanReviewLoop(
  initialPlan: string,
  opts: PlanReviewLoopOptions = {},
): Promise<PlanReviewLoopResult> {
  if (typeof initialPlan !== "string" || initialPlan.trim().length === 0) {
    throw new Error(
      "runPlanReviewLoop(initialPlan): plan must be a non-empty string",
    );
  }

  const maxIterations = opts.max_iterations ?? DEFAULT_MAX_ITERATIONS;
  const stopWhenAcceptable = opts.stop_when_acceptable ?? true;

  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error(
      `runPlanReviewLoop: max_iterations must be a positive integer (got ${String(maxIterations)})`,
    );
  }

  const passOpts: PlanReviewOptions = {
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(opts.focus ? { focus: opts.focus } : {}),
    ...(opts.steering ? { steering: opts.steering } : {}),
  };

  const iterations: PlanReviewLoopIteration[] = [];
  let currentPlan = initialPlan;
  let previousSeverity: number | null = null;
  let terminatedReason: PlanReviewLoopResult["terminated_reason"] = "max_iterations";

  for (let i = 0; i < maxIterations; i++) {
    const review = await runPlanReview(currentPlan, passOpts);
    const iter: PlanReviewLoopIteration = {
      iteration: i + 1,
      plan: currentPlan,
      review,
    };
    iterations.push(iter);

    log.info("plan review iteration complete", {
      iteration: iter.iteration,
      verdict: review.verdict,
      severity_score: review.severity_score,
      gap_count: review.gaps.length,
    });

    if (review.verdict === "unfit") {
      terminatedReason = "unfit_short_circuit";
      break;
    }

    if (stopWhenAcceptable && review.verdict === "acceptable") {
      terminatedReason = "verdict_acceptable";
      break;
    }

    if (previousSeverity !== null) {
      const dropped = previousSeverity - review.severity_score;
      if (dropped <= SEVERITY_CONVERGENCE_TOLERANCE) {
        terminatedReason = "severity_converged";
        break;
      }
    }

    if (i === maxIterations - 1) {
      // Final iteration — don't bother producing a revision we won't review.
      terminatedReason = "max_iterations";
      break;
    }

    previousSeverity = review.severity_score;
    currentPlan = await produceRevisedPlan(currentPlan, review);
  }

  return { iterations, terminated_reason: terminatedReason };
}
