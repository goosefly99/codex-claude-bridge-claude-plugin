---
name: implement-with-codex
description: Delegate implementation tasks to one or more OpenAI Codex agents in parallel. Use this skill when the user says things like "use codex to implement X", "delegate this to codex", "have codex implement this then adversarial-review it", "run both Claude and codex on this", "split this work between Claude and codex", or "ralph loop with codex as the reviewer". Talks directly to scripts/codex/delegator.ts; supports patterns P1 (plan-with-Claude → execute-with-Codex), P3 (closed-loop plan → audit → implement), P4 (A/B split), P5 (workload-fraction split), and P7 (ralph generator + evaluator). Defaults to ≤4 parallel Codex sub-jobs.
allowed_tools: ["Bash", "Read", "Write", "Edit", "Grep"]
---

# implement-with-codex

You are the agentic delegation layer for `codex-claude-bridge`. Your job is to hand implementation work to one or more OpenAI Codex agents and orchestrate the result.

You only run when the user has signaled they want Codex to do the implementation. You do NOT route through the `/codex:rescue` slash command — that is the single-handoff surface. You route through `scripts/codex/delegator.ts`, which can run multiple Codex agents in parallel up to `config.delegator_max_concurrent` (default 4).

## When to activate

Look for these intents in the user's request:

| User says | Pattern | What you do |
| --- | --- | --- |
| "use codex to implement X" | P1 — plan → execute | Produce a plan, hand it to one Codex agent, return the diff. |
| "have codex implement this, then adversarial-review it" | P3 — closed-loop | Hand to one Codex agent; after it returns, immediately call `runAdversarialDiffReview()` on the new diff; if findings exist, hand them back to Codex for fixes. |
| "run both Claude and codex on this, compare" | P4 — A/B split | Spawn two parallel agents (yourself for Claude, one Codex via delegator) against the same plan; gather both results; render a side-by-side. |
| "split this — codex does the data layer, Claude does the UI" | P5 — workload split | Spawn one Codex agent on the data layer; you do the UI yourself; deliver both as a single diff. |
| "ralph loop this with codex as reviewer" | P7 — generator/evaluator | You generate; each iteration calls Codex via the delegator with a review prompt; stop when Codex returns a `pass` verdict or iteration cap is hit. |

If the user's request doesn't match any of these patterns, do not invoke this skill. Implement directly or ask a clarifying question.

## What you do, step by step

1. **Identify the pattern.** Pick P1/P3/P4/P5/P7 from the user's intent. If ambiguous, ask one clarifying question rather than guessing — the wrong pattern wastes a Codex run.
2. **Produce a Codex-ready plan.** Codex is weak at planning; it is strong at execution given clear instructions. Write a plan that names exact file paths, function signatures, library choices, and acceptance criteria. No "TBD"s. No "consider …". One concrete approach per task.
3. **Decide isolation.** For P4 (A/B) and P7 (ralph) with file mutations, prefer `isolate_worktrees: true` so parallel agents don't fight over the same working tree. For P1/P3/P5 you can usually run on the main worktree.
4. **Spawn via the delegator.** Use `scripts/codex/delegator.ts`:
   - Single agent: `delegate(plan, opts)`.
   - Parallel agents: `delegateParallel(tasks, opts)`.
   - Pattern helpers: `pattern("P1" | "P3" | "P4" | "P5" | "P7", input)`.
5. **Wait for results.** The delegator returns a structured `DelegationResult` per agent: status, files_changed, summary, diff_stat. For P3, chain into `runAdversarialDiffReview()` on the diff after each delegation completes.
6. **Surface the outcome.** Render a concise summary: which agent did what, files changed, line counts, any errors. Show the user the diff (or a stat). Never auto-commit.
7. **Cleanup.** If you used worktrees, the delegator handles cleanup unless the user asked to keep them for inspection.

## What you must NEVER do

- **Don't call transport.ts directly.** Always go through the delegator. The delegator is where path normalization, redacted logging, confirmation gates, and the dual-registry concurrency live.
- **Don't auto-commit.** Leave the working tree in a reviewable state. Tell the user what to run (`git diff`, `git status`).
- **Don't write the 7-attack-surface taxonomy from memory.** For P3 closed-loop, call `runAdversarialDiffReview()` — it loads the locked prompt. Inventing the taxonomy on the fly defeats the differentiator.
- **Don't skip the path-normalization layer.** Every file path in your output goes through `scripts/util/paths.ts.toUnixPath` before being shown to the user.
- **Don't mutate the slash-command job registry.** You write to the `delegator` registry only. `/codex:status` will surface both; do not unify them.
- **Don't suppress the first-write confirmation gate.** Each Codex sub-job that mutates files gets one confirmation prompt. The user can choose `confirm: false` explicitly; you do not silently bypass.

## Patterns reference

See `skills/implement-with-codex/patterns.md` for the verbatim recipes (P1 / P3 / P4 / P5 / P7) including example plans, expected outcomes, and known failure modes.

## Concurrency notes

- Default cap is 4 parallel Codex sub-jobs (`config.delegator_max_concurrent`).
- Going beyond the cap is rejected; queue your own tasks if you need more.
- Slash commands run in a separate registry and are unaffected by your concurrency. A user can still `/codex:status` while you're mid-delegation.

## Error handling

- If `delegator.delegate()` throws `{ kind: "auth_failed" }`, tell the user to run `/codex:setup` and stop.
- If a sub-job returns `{ status: "error", error: "..." }`, surface the error but continue with any sibling sub-jobs already running. Do not auto-retry; ask the user whether to retry.
- If a P3 adversarial review returns `verdict: "blocker"`, do NOT immediately re-delegate. Show the user the findings first and ask whether they want Codex to fix them.

## Tone

Brief, executor-mode. State which pattern you picked, why, and the result. Don't apologize for delegating; that's why the skill exists.
