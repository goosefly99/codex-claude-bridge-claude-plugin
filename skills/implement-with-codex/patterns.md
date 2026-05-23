# Delegation Patterns Reference

These are the canonical patterns the `implement-with-codex` skill drives. Each is a recipe with: trigger, plan template, expected output, and known failure modes.

---

## P1 — Plan-with-Claude → Execute-with-Codex

**Trigger phrases:** "use codex to implement X", "have codex do this", "I'm low on Anthropic tokens — get codex to do it".

**When to use:** The task has a clear plan but Claude is being slow, expensive, or running into context limits. Codex's execution discipline > its planning.

**Plan template:**
```
Goal: <one-sentence goal>
Files to modify: <list with explicit paths>
Functions/types to add or change: <signatures>
Acceptance criteria: <how Codex can verify it's done>
Out of scope: <explicit non-goals>
```

**Invocation:**
```ts
await delegate(plan, { pattern: "P1" });
```

**Expected output:** One `DelegationResult` with status `"completed"`, diff in the working tree, summary string.

**Known failure modes:**
- Codex over-reports progress. Always check the diff before accepting "done".
- Codex doesn't ask clarifying questions; if the plan is ambiguous it will guess. Tighten the plan if you see drift.

---

## P3 — Closed-Loop: Plan → Audit → Implement

**Trigger phrases:** "have codex implement this, then adversarial-review it", "loop until codex says it's safe to ship".

**When to use:** High-stakes change. You want the audit-and-fix cycle inside one delegation.

**Plan template:** Same as P1, plus:
```
Audit gate: stop when /codex:adversarial-review returns `verdict: "pass"` OR after 3 iterations.
```

**Invocation:**
```ts
await pattern("P3", {
  plan,
  max_iterations: 3,
  audit_gate: "pass",
});
```

**Expected output:** An array of `DelegationResult`s (one per iteration) plus the final `AdversarialOutput`. The last iteration's diff is in the working tree.

**Known failure modes:**
- "Pass" verdicts can be cosmetic. Spot-check the final diff manually.
- If Codex repeatedly fails the audit gate, it may be misreading the findings. Pause after iteration 2 and read the adversarial output yourself before letting iteration 3 fire.

---

## P4 — A/B Implementation Split

**Trigger phrases:** "run both Claude and codex on this, compare", "let's see which model does this better".

**When to use:** Design choice is ambiguous; you want to see which model produces a better artifact. Empirically the two overlap on roughly 1 finding in 11 — they really are different.

**Recommended config:** `delegator_isolate_worktrees: true`. Without isolation, the two agents fight over the working tree.

**Plan template:** Same as P1 but written generically (don't bias either agent toward your own approach).

**Invocation:**
```ts
const [claudeResult, codexResult] = await delegateParallel(
  [
    { agent: "claude", plan },
    { agent: "codex", plan },
  ],
  { isolate_worktrees: true },
);
```

Note: the `claude` agent in `delegateParallel` is actually just *you* running in this same session; the delegator returns a slot for your own implementation. The point is symmetry — both implementations land in side-by-side worktrees the user can compare.

**Expected output:** Two `DelegationResult`s. Render side-by-side: file count, line count, summary.

**Known failure modes:**
- Cherry-picking. The user often wants a hybrid. Be ready to do P5 (split) as a follow-up.
- Worktree leakage. Always clean up unless the user asks to inspect.

---

## P5 — Workload-Fraction Split

**Trigger phrases:** "codex does the data layer, claude does the UI", "split this 70/30".

**When to use:** Multi-stage task with clearly different cognitive loads. Use Claude where exploration/creativity matters; use Codex where execution discipline matters.

**Plan template:** Two sub-plans (one per agent), each with its own goal / files / acceptance criteria. Boundary between them is explicit.

**Invocation:**
```ts
await pattern("P5", {
  codex_share: claudePart,
  claude_share: codexPart, // documented for the user; you implement it inline
});
```

**Expected output:** One `DelegationResult` for the Codex share; you do the Claude share inline. Final diff combines both.

**Known failure modes:**
- Boundary bleed. If Codex touches files outside its share, surface this as an error and ask the user how to proceed.
- Order matters. If Codex's share depends on Claude's share existing, do Claude's first.

---

## P7 — Ralph Loop (Generator + Evaluator)

**Trigger phrases:** "ralph loop this", "generator/evaluator with codex".

**When to use:** Long-running agentic build where you want a separate evaluator agent.

**Recommended config:** `delegator_isolate_worktrees: true` if the loop mutates files. Otherwise loop on read-only review.

**Plan template:**
```
Generator role: you (Claude).
Evaluator role: Codex via delegator.
Iteration cap: <N>.
Termination: evaluator returns OK / pass / approve.
```

**Invocation:**
```ts
await pattern("P7", {
  generate: claudeGenerator,
  evaluate: codexEvaluator,
  max_iterations: 5,
});
```

**Expected output:** Iteration log and final state. Each iteration is a `DelegationResult` from Codex.

**Known failure modes:**
- Endless loops. Always set a cap.
- Evaluator drift. Codex may start nit-picking style; pin its prompt to the specific evaluation criteria.

---

## Cross-pattern notes

- **Path normalization:** always `toUnixPath()` file references before showing to the user.
- **Logging:** the delegator logs every sub-job under `${CLAUDE_PLUGIN_DATA}/codex-bridge/logs/`. Tokens are redacted.
- **Cancellation:** if the user changes their mind mid-flight, call `jobManager.cancel("delegator")` to abort all delegator sub-jobs (slash commands are unaffected).
- **Worktree cleanup:** always cleanup unless the user asks to inspect. Worktrees left lying around are confusing and waste disk.
