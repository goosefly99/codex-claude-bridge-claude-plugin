---
name: codex:review
description: Neutral code review of the current diff using OpenAI Codex. Auto-classifies large diffs (8 files / 500 LOC defaults) and supports --background / --wait routing.
argument_hint: "[--effort low|medium|high] [--background|--wait] [<git-ref>]"
allowed_tools: ["Bash", "Read"]
script: ${CLAUDE_PLUGIN_ROOT}/scripts/codex/adversarialEngine.ts
---

# /codex:review

You are running the `codex-claude-bridge` neutral review command. This is the non-adversarial sibling of `/codex:adversarial-review`: same diff handling, same transport, same auto-classification — but a *neutral* system prompt without the 7-attack-surface taxonomy. Use it when the user wants a calm second-pair-of-eyes pass rather than a hostile audit.

## Arguments

- `--effort low|medium|high` — reasoning effort hint passed to Codex. Default: `medium`.
- `--background` — force background execution regardless of diff size.
- `--wait` — force synchronous execution regardless of diff size.
- `<git-ref>` — optional ref or refspec (e.g. `main..HEAD`). Default: uncommitted working-tree changes.

## Steps

1. Verify that a token is cached via `tokenStore.load()`. If not, instruct the user to run `/codex:setup` and exit with code 2.
2. Resolve the diff target:
   - If a ref is provided, use it.
   - Otherwise, use uncommitted working-tree changes.
   - If the repo has zero commits, delegate to `${CLAUDE_PLUGIN_ROOT}/scripts/git/greenfield.ts.prepareReviewBase()`.
   - If there is no git repo, exit with code 3 and a clear "run `git init` first" message.
3. Auto-classify diff size via `${CLAUDE_PLUGIN_ROOT}/scripts/codex/sizeClassifier.ts.classifyDiff()`.
   - If `--background` or `--wait` is set, it overrides classification.
   - If the classification is `background` and no flag is set, prompt the user to choose `--background` or `--wait`.
4. Load `${CLAUDE_PLUGIN_ROOT}/prompts/review-system.md` as the system prompt (NOT the adversarial prompt).
5. Build the user prompt: include the diff stat, the diff body (capped at the configured token budget), and any user-provided focus area passed as positional args.
6. Dispatch via `${CLAUDE_PLUGIN_ROOT}/scripts/codex/transport.ts.sendCompletion()`.
   - Synchronous: render the response inline as Markdown.
   - Background: enqueue via `${CLAUDE_PLUGIN_ROOT}/scripts/concurrency/jobManager.ts.enqueue()`, print job ID, and tell the user to run `/codex:status`.

## Constraints

- This is the *neutral* review. Do NOT inject the 7-attack-surface taxonomy here. That's `/codex:adversarial-review` exclusively.
- The output of `/codex:review` is unstructured prose. Closed-loop plan-mode integration is the adversarial command's job.
- All retries (429, 5xx) go through the transport's exponential-backoff layer; this command does not retry independently.
