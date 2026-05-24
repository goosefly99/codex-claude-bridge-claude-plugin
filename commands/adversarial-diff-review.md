---
name: codex:adversarial-diff-review
description: Hostile code review of the current diff across 7 hard-coded attack surfaces (Authentication, Data loss, Rollbacks, Race conditions, Degraded dependencies, Version skew, Observability gaps). Returns structured JSON consumable by Claude plan mode for closed-loop fix implementation. For adversarial review of arbitrary files or folders, use /codex:adversarial-review.
argument_hint: "[--effort low|medium|high] [--focus <surface>] [--background|--wait] [<git-ref>]"
allowed_tools: ["Bash", "Read"]
script: ${CLAUDE_PLUGIN_ROOT}/dist/codex/cli-adversarial-diff-review.js
---

# /codex:adversarial-diff-review

You are running the flagship command of `codex-claude-bridge`. This command runs Codex against the current diff with a *hostile* mindset, forcing it to reason through each of seven hard-coded attack surfaces in order, and emits structured JSON validated against `${CLAUDE_PLUGIN_ROOT}/schemas/adversarial-output.json`.

For an adversarial review of arbitrary files or folders (no git diff involved), use `/codex:adversarial-review` instead — same 7-surface taxonomy, same JSON output shape, but the input is a filesystem path rather than a base/head diff.

## Arguments

- `--effort low|medium|high` — reasoning effort. Default: `high` (this is the high-stakes review).
- `--focus <surface>` — narrow to a single surface. Must match one of: `Authentication`, `Data loss`, `Rollbacks`, `Race conditions`, `Degraded dependencies`, `Version skew`, `Observability gaps`. By default, all 7 surfaces run.
- `--background` / `--wait` — concurrency override.
- `<git-ref>` — optional ref or refspec. Default: uncommitted working-tree changes.

## The 6 phases

This command delegates to `${CLAUDE_PLUGIN_ROOT}/scripts/codex/adversarialEngine.ts.runAdversarialDiffReview()`, which orchestrates:

1. **Argument parsing.** Validate flags. Reject unknown surfaces in `--focus` with a list of valid values.
2. **Size estimation.** Call `sizeClassifier.classifyDiff()`. Honor explicit `--background` / `--wait`.
3. **Target resolution.** Resolve to a concrete (base, head) ref pair. Delegate to `git/greenfield.ts.prepareReviewBase()` when no commits exist. Refuse if there is no git repo.
4. **Context collection.** Gather the diff body, file-level metadata, and (selectively) full file content for files referenced by the diff. Cap total context at the configured token budget.
5. **Prompt construction.** Load `${CLAUDE_PLUGIN_ROOT}/prompts/adversarial-system.md` as the system prompt — DO NOT modify it. Inject the user-provided steering directive (if any) and the collected context as the user prompt. The 7 attack surface names live verbatim in the system prompt; do not generate them dynamically.
6. **Dispatch and validate.** Call `transport.sendCompletion()`. Parse the response as JSON. Validate against `${CLAUDE_PLUGIN_ROOT}/schemas/adversarial-output.json`. On validation failure, surface the parsed-best-effort findings with a clear "schema violation" warning.

## Output

Render the JSON to the terminal AND emit it as a Claude tool-result. The tool-result is what enables closed-loop integration: a subsequent Claude plan-mode turn re-reads the JSON and proposes fixes (patterns P2, P3, P7).

The schema includes:
- `verdict`: one of `pass | needs-changes | blocker`
- `severity_buckets`: `{critical: [], high: [], medium: [], low: []}` — each issue has `{file, line, surface, description, fix_hint}`
- `next_steps`: short ordered list of actions
- `safe_to_ship`: array of file paths the reviewer is comfortable shipping

## Constraints

- The 7 attack surfaces are HARD-CODED in `prompts/adversarial-system.md`. This is enforced by `tests/anti-drift.test.ts`. Never generate them dynamically.
- Output MUST be valid JSON conforming to the schema. Free-form prose responses are a regression.
- Always emit the result as a tool-result so plan mode can consume it. Do not summarize or paraphrase the JSON in chat — render it raw.
- If the user is asking about content outside the working diff, redirect them to `/codex:adversarial-review <path...>` rather than running this command on unrelated changes.
