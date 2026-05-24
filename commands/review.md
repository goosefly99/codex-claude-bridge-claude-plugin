---
name: codex:review
description: Neutral review of arbitrary files or folders via OpenAI Codex. Walks the supplied paths, respects .gitignore, and caps content at the configured token budget. For reviewing a git diff instead, use /codex:diff-review.
argument_hint: "[--effort low|medium|high] [--question <text>] [--background|--wait] <path...>"
allowed_tools: ["Bash", "Read"]
script: ${CLAUDE_PLUGIN_ROOT}/dist/codex/cli-review.js
---

# /codex:review

You are running the `codex-claude-bridge` general-purpose neutral review command. This is the non-adversarial sibling of `/codex:adversarial-review`. Use it when the user wants a calm second-pair-of-eyes pass over an arbitrary file, folder, or set of paths — not a git diff.

For reviewing the working diff or a specific git refspec, use `/codex:diff-review` instead.

## Arguments

- `--effort low|medium|high` — reasoning effort hint passed to Codex. Default: `medium`.
- `--question <text>` — optional user question or focus area. Surfaced to Codex as a steering directive before the file contents.
- `--background` — force background execution.
- `--wait` — force synchronous execution.
- `<path...>` — one or more files or folders to review. Required. Paths must resolve inside the current working directory.

## Steps

1. Verify that a token is cached via `tokenStore.load()`. If not, instruct the user to run `/codex:setup` and exit with code 2.
2. If no paths are supplied, exit with code 5 and a message that points the user at `/codex:diff-review` if they meant the diff.
3. Walk each path via `${CLAUDE_PLUGIN_ROOT}/scripts/codex/fsContext.ts.collectFilesystemContext()`:
   - Files are read directly. Directories are walked recursively.
   - Inside a git repo, `git check-ignore` is consulted to skip ignored files.
   - Outside a git repo, a fallback deny-list (`node_modules`, `dist`, `.acv`, etc., plus dot-prefixed directories) applies.
   - Binary files and files larger than the per-file cap are skipped.
   - Total content is capped at `config.context_token_budget`; overflow files are listed under `skipped`.
4. Load `${CLAUDE_PLUGIN_ROOT}/prompts/review-system.md` as the system prompt (NOT the adversarial prompt).
5. Build the user prompt: prepend a one-paragraph framing ("you are reviewing arbitrary filesystem content, not a diff"), then include the user's `--question` (if any), then the collected files as fenced blocks.
6. Dispatch via `${CLAUDE_PLUGIN_ROOT}/scripts/codex/transport.ts.sendCompletion()`.
   - Synchronous: render the response inline as Markdown.
   - Background: enqueue via `${CLAUDE_PLUGIN_ROOT}/scripts/concurrency/jobManager.ts.enqueue()`, print job ID, and tell the user to run `/codex:status`.

## Constraints

- This is the *neutral* review. Do NOT inject the 7-attack-surface taxonomy here. That's `/codex:adversarial-review` (or `/codex:adversarial-diff-review`) exclusively.
- Paths must resolve inside the current working directory. Reject attempts to read elsewhere on the filesystem.
- All retries (429, 5xx) go through the transport's exponential-backoff layer; this command does not retry independently.
- If the user's question is really about a diff, prefer `/codex:diff-review`.
