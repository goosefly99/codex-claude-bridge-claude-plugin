---
name: codex:adversarial-review
description: Hostile review of arbitrary files or folders across 7 hard-coded attack surfaces (Authentication, Data loss, Rollbacks, Race conditions, Degraded dependencies, Version skew, Observability gaps). Returns structured JSON. For adversarial review of a git diff instead, use /codex:adversarial-diff-review.
argument_hint: "[--effort low|medium|high] [--focus <surface>] [--question <text>] [--background|--wait] <path...>"
allowed_tools: ["Bash", "Read"]
script: ${CLAUDE_PLUGIN_ROOT}/dist/codex/cli-adversarial-review.js
---

# /codex:adversarial-review

You are running the general-purpose adversarial review command of `codex-claude-bridge`. Same 7-attack-surface taxonomy as `/codex:adversarial-diff-review`, same locked system prompt, same structured JSON output schema — but the input is one or more filesystem paths instead of a git diff.

For an adversarial review of the working diff or a specific git refspec, use `/codex:adversarial-diff-review` instead.

## Arguments

- `--effort low|medium|high` — reasoning effort. Default: `high`.
- `--focus <surface>` — narrow to a single surface. Must match one of: `Authentication`, `Data loss`, `Rollbacks`, `Race conditions`, `Degraded dependencies`, `Version skew`, `Observability gaps`. By default, all 7 surfaces run.
- `--question <text>` — optional steering directive.
- `--background` / `--wait` — concurrency override.
- `<path...>` — one or more files or folders to review. Required. Paths must resolve inside the current working directory.

## Steps

This command delegates to `${CLAUDE_PLUGIN_ROOT}/scripts/codex/adversarialEngine.ts.runGeneralAdversarialReview()`. The shape mirrors the 6-phase diff version, with steps 2–3 replaced by filesystem walk:

1. **Argument parsing.** Validate flags. Reject unknown surfaces in `--focus` with a list of valid values. If no paths are supplied, exit with code 5 and a message that points the user at `/codex:adversarial-diff-review` if they meant the diff.
2. **Filesystem context collection.** Call `${CLAUDE_PLUGIN_ROOT}/scripts/codex/fsContext.ts.collectFilesystemContext()` against the supplied paths. Apply git ignore rules (or the fallback deny-list outside a git repo), skip binaries, cap at the configured token budget. Any skipped paths are surfaced to the model so it knows what it did NOT see.
3. **Prompt construction.** Load `${CLAUDE_PLUGIN_ROOT}/prompts/adversarial-system.md` as the system prompt — DO NOT modify it. Prepend a one-paragraph framing ("you are reviewing arbitrary filesystem content, not a diff"). Inject the user-provided steering directive (if any) and the collected file contents as the user prompt. The 7 attack surface names live verbatim in the system prompt; do not generate them dynamically.
4. **Dispatch and validate.** Call `transport.sendCompletion()`. Parse the response as JSON. Validate against `${CLAUDE_PLUGIN_ROOT}/schemas/adversarial-output.json`. On validation failure, surface the parsed-best-effort findings with a clear "schema violation" warning.

## Output

Same shape as `/codex:adversarial-diff-review`:

- `verdict`: one of `pass | needs-changes | blocker`
- `severity_buckets`: `{critical: [], high: [], medium: [], low: []}` — each issue has `{file, line, surface, description, fix_hint}`
- `next_steps`: short ordered list of actions
- `safe_to_ship`: array of file paths the reviewer is comfortable shipping

Render the JSON to the terminal AND emit it as a Claude tool-result so plan mode can consume it.

## Constraints

- The 7 attack surfaces are HARD-CODED in `prompts/adversarial-system.md`. This is enforced by `tests/anti-drift.test.ts`. Never generate them dynamically.
- Paths must resolve inside the current working directory. Reject attempts to read elsewhere on the filesystem.
- Output MUST be valid JSON conforming to the schema. Free-form prose responses are a regression.
- Always emit the result as a tool-result so plan mode can consume it. Do not summarize or paraphrase the JSON in chat — render it raw.
- If the user's question is really about a diff, prefer `/codex:adversarial-diff-review`.
