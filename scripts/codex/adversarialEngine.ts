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

/** Enum of the 6 internal phases. Sequential, deterministic. */
export enum AdversarialPhase {
  ARGUMENT_PARSING = 1,
  SIZE_ESTIMATION = 2,
  TARGET_RESOLUTION = 3,
  CONTEXT_COLLECTION = 4,
  PROMPT_CONSTRUCTION = 5,
  DISPATCH_AND_VALIDATE = 6,
}

/** The 7 hard-coded attack surfaces. Verbatim. Anti-drift test enforced. */
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

/** Per-issue payload emitted in severity buckets. */
export interface AdversarialIssue {
  file: string;
  line: number;
  surface: AttackSurface;
  description: string;
  fix_hint: string;
}

/** The structured output of /codex:adversarial-review. Schema-validated. */
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

/** Options accepted by runAdversarialReview. Mirrors the slash-command flags. */
export interface AdversarialOptions {
  effort?: "low" | "medium" | "high";
  focus?: AttackSurface;
  background?: boolean;
  wait?: boolean;
  /** Optional steering directive provided by the user. */
  steering?: string;
}

/**
 * Top-level entry point. Orchestrates phases 1–6 and returns the parsed +
 * validated output. On schema-validation failure, returns a parse-tolerant
 * partial result with a non-fatal warning (caller decides whether to surface).
 *
 * @param target Optional git ref or refspec. Default: uncommitted changes.
 * @param opts Adversarial review options.
 * @returns The structured adversarial output.
 */
export async function runAdversarialReview(
  _target?: string,
  _opts?: AdversarialOptions,
): Promise<AdversarialOutput> {
  throw new Error("not implemented");
}

// -----------------------------------------------------------------------------
// Phase implementations — each is its own pure-ish function so they can be
// individually tested. The orchestrator above wires them together.
// -----------------------------------------------------------------------------

/** Phase 1: validate flags and resolve defaults. */
export function parseArguments(
  _target: string | undefined,
  _opts: AdversarialOptions | undefined,
): AdversarialOptions {
  throw new Error("not implemented");
}

/** Phase 2: classify diff size; return "sync" or "background". */
export async function estimateSize(
  _target: string,
): Promise<"sync" | "background"> {
  throw new Error("not implemented");
}

/** Phase 3: resolve a concrete (base, head) ref pair, handling greenfield. */
export async function resolveTarget(
  _target: string | undefined,
): Promise<{ base: string; head: string }> {
  throw new Error("not implemented");
}

/** Phase 4: collect diff body + selective file content under token budget. */
export async function collectContext(_targetRefs: {
  base: string;
  head: string;
}): Promise<{ diff: string; files: Map<string, string> }> {
  throw new Error("not implemented");
}

/** Phase 5: load locked system prompt, inject context. */
export async function buildPrompt(
  _ctx: { diff: string; files: Map<string, string> },
  _opts: AdversarialOptions,
): Promise<{ system: string; user: string }> {
  throw new Error("not implemented");
}

/** Phase 6: dispatch via transport, parse JSON, validate against schema. */
export async function dispatchAndValidate(
  _prompt: { system: string; user: string },
  _opts: AdversarialOptions,
): Promise<AdversarialOutput> {
  throw new Error("not implemented");
}
