# Use-Case Patterns

This document explains the five delegation patterns available through the `implement-with-codex` skill. Each pattern answers: **when should I use this, how do I trigger it, and what do I get back.**

The patterns build on a core empirical observation: Claude and Codex agree on roughly **1 finding in 11** in adversarial review. Using them together consistently surfaces issues that either model alone would miss.

---

## Quick reference

| Pattern | When to reach for it | Complexity |
|---------|---------------------|------------|
| [P1 — Hand off a clear plan to Codex](#p1--hand-off-a-clear-plan-to-codex) | Clear plan, Claude hitting limits | Low |
| [P3 — Codex implements and audits its own work](#p3--codex-implements-and-audits-its-own-work) | High-stakes change, want closed-loop QA | Medium |
| [P4 — A/B: Claude vs Codex side by side](#p4--ab-claude-vs-codex-side-by-side) | Ambiguous design, want two independent takes | Medium |
| [P5 — Split the workload by cognitive type](#p5--split-the-workload-by-cognitive-type) | Multi-stage task with clear ownership boundaries | Medium |
| [P7 — Ralph Loop: generator + evaluator](#p7--ralph-loop-generator--evaluator) | Long-running agentic build with iterative refinement | High |

---

## P1 — Hand off a clear plan to Codex

**When to use:** The task is fully planned and you want Codex to do the execution. Common triggers:
- Claude is running low on context or tokens.
- The work is mechanical (renaming, scaffolding, schema migrations, test generation).
- You want Codex's execution discipline for a well-defined change.

**Example prompt:**
> "Use Codex to implement the `UserRepository` class per the plan I just wrote."

**What you need to provide:** A concrete plan. Codex doesn't ask clarifying questions — if the plan is vague, it will guess. The plan should include:
- One-sentence goal
- Exact file paths to create or modify
- Function/type signatures
- Acceptance criteria (how Codex can verify it's done)
- Explicit non-goals (what to leave alone)

**Expected outcome:** One completed `DelegationResult` with a diff in your working tree. Review the diff before committing — Codex sometimes over-reports progress.

**Common failure mode:** The plan is ambiguous at a branch point. Fix: add explicit `Out of scope:` and `Boundary:` lines to your plan before delegating.

---

## P3 — Codex implements and audits its own work

**When to use:** You want Codex to implement *and* run the adversarial review on its own output, iterating until it passes (or until you stop it at 3 iterations). Best for:
- Security-sensitive changes (auth, permissioning, data pipelines).
- API changes that could silently break downstream consumers.
- Any change where you'd normally run `/codex:adversarial-diff-review` (for diffs) or `/codex:adversarial-review` (for arbitrary content) anyway.

**Example prompt:**
> "Have Codex implement the OAuth refresh flow, then adversarial-review it. Loop until it says it's safe to ship."

**What you need to provide:** Same concrete plan as P1, plus an audit gate:
```
Audit gate: stop when verdict is "pass" OR after 3 iterations.
```

**Expected outcome:** An array of `DelegationResult`s (one per iteration) plus the final `AdversarialOutput`. The final diff is in your working tree.

**Common failure mode:** "Pass" verdicts can be cosmetic. Codex optimizes for the structured JSON output, not actual security. Spot-check the final adversarial output yourself before shipping. If you see `severity_buckets.critical` is empty but the diff touches auth code, read the diff anyway.

---

## P4 — A/B: Claude vs Codex side by side

**When to use:** You have an ambiguous design choice and want two independent implementations to compare. Typical triggers:
- "Which model will produce a cleaner API design here?"
- "I'm not sure whether to use X or Y — let's see both."
- Any time you want data rather than a single model's opinion.

**Example prompt:**
> "Run both Claude and Codex on the event-sourcing refactor and compare the results."

**Setup note:** Enable `delegator_isolate_worktrees: true` in config. Without worktree isolation the two agents write to the same tree and create conflicts.

**What you need to provide:** A single plan that doesn't bias either agent toward a specific approach. Phrase acceptance criteria in outcome terms, not implementation terms.

**Expected outcome:** Two `DelegationResult`s, one per agent, landing in side-by-side worktrees. The skill will render a comparison: file count, lines changed, summary. You then cherry-pick or synthesize.

**Common failure mode:** Cherry-picking produces a frankenstein merge. If you take pieces from both, run P3 on the merged result before shipping to catch integration gaps.

---

## P5 — Split the workload by cognitive type

**When to use:** Multi-stage task with clearly different cognitive demands. The rule of thumb:
- **Claude's share:** exploration, design, UI/UX, open-ended reasoning, code that needs context from earlier in the session.
- **Codex's share:** mechanical execution, data-layer scaffolding, test generation, boilerplate, anything with clear acceptance criteria.

**Example prompt:**
> "Codex handles the Postgres schema and migrations; Claude handles the API layer and business logic."

**What you need to provide:** Two sub-plans with an explicit boundary between them. Each sub-plan should be self-contained (no hidden dependency on the other unless you specify order).

**Expected outcome:** One `DelegationResult` for the Codex share; you implement the Claude share inline in the same session. The combined diff covers both.

**Common failure mode:** Boundary bleed — Codex touches files outside its share. The skill surfaces this as an error and asks you what to do. If the boundary was wrong, renegotiate it before continuing rather than letting Codex guess.

**Order matters:** If Codex's share depends on yours (or vice versa), specify the order explicitly. The default is Codex first; override this in your plan if needed.

---

## P7 — Ralph Loop: generator + evaluator

**When to use:** You have a long-running agentic build that benefits from a tight generate→evaluate→improve cycle. Examples:
- Iterative code optimization where the acceptance criterion is a benchmark threshold.
- Test-driven development where Codex implements until tests pass.
- Document drafting where Codex reviews and scores each draft.

**Example prompt:**
> "Ralph loop this: Claude generates the caching layer, Codex evaluates it against the seven attack surfaces. Cap at 5 iterations."

**What you need to provide:**
- Generator role (you/Claude): the plan for each generation step.
- Evaluator role (Codex): explicit evaluation criteria. Be specific — Codex without specific criteria will nit-pick style and the loop won't terminate.
- Iteration cap: always set one. Without a cap, loops run until you stop them manually.
- Termination condition: what "good enough" looks like (`verdict: "pass"`, all tests green, benchmark below threshold, etc.).

**Expected outcome:** An iteration log showing each cycle's `DelegationResult` and the evaluator's verdict. The final state is in your working tree.

**Common failure modes:**
- **Evaluator drift:** Codex starts inventing new criteria after iteration 2. Fix: pin the evaluator prompt to a specific rubric (the seven attack surfaces, the six plan-review categories, or a custom checklist).
- **Generator stubbornness:** Claude re-generates the same artifact. Fix: explicitly tell Claude "you must change X based on the evaluator's finding" in the generation prompt.
- **Iteration cap too low:** The loop terminates before a meaningful improvement. Fix: set cap to at least 3.

---

## Choosing between patterns

```
Is the task fully planned and mechanical?
  └─ Yes → P1 (hand off to Codex)
  └─ No, it's high-stakes or security-sensitive?
       └─ Yes → P3 (implement + audit loop)
       └─ No, design is ambiguous?
            └─ Yes → P4 (A/B comparison)
            └─ No, multi-stage with clear ownership?
                 └─ Yes → P5 (workload split)
                 └─ No, long-running with iterative refinement?
                      └─ Yes → P7 (Ralph loop)
```

For most day-to-day work: **P1** when the plan is clear, **P3** when the stakes are high. The others are for specific structural situations.

---

## Tips that apply to all patterns

- **Review every diff before committing.** The skill never auto-commits. This is intentional — Codex can misread ambiguous acceptance criteria and produce plausible-but-wrong output.
- **Worktree cleanup:** Worktrees created by P4 and P7 are left for inspection unless you confirm cleanup. Don't let them accumulate.
- **Token budget:** Codex's context window is finite. Very large diffs or files get truncated at the configured `context_token_budget`. If a review feels shallow, reduce the diff scope or increase the budget in config.
- **Logs are local:** all Codex interactions are logged (redacted) to `${CLAUDE_PLUGIN_DATA}/codex-bridge/logs/`. If something behaves unexpectedly, the log is the first place to look.
