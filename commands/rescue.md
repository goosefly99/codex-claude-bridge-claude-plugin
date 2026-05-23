---
name: codex:rescue
description: Hand a Claude-authored plan to OpenAI Codex for execution. Mutates the working tree under user-confirmed permissions; the first file write requires explicit confirmation.
argument_hint: "<plan-or-task-description>"
allowed_tools: ["Bash", "Read", "Write", "Edit"]
script: ${CLAUDE_PLUGIN_ROOT}/scripts/codex/adversarialEngine.ts
---

# /codex:rescue

You are running the execution-rescue command. This is how a user hands an in-progress task to Codex when Claude is stuck, looping, or running out of context. The interaction model is: Claude plans, Codex executes.

## Arguments

- `<plan-or-task-description>` — required. Either a full plan written by Claude (paste or refer to the prior turn), or a short task description if the plan is implicit from session context.

## Steps

1. Verify token via `tokenStore.load()`. If absent or expired beyond refresh, exit code 2 with "run /codex:setup".
2. Capture the plan/task. If the user provided no positional arg, surface an error pointing them at the argument-hint syntax.
3. Load `${CLAUDE_PLUGIN_ROOT}/prompts/rescue-system.md` as the system prompt. This prompt frames Codex as the executor of a Claude-authored plan, with explicit instructions to (a) work in small atomic edits, (b) explain each edit briefly before making it, (c) request a confirmation before the first write, (d) stop and report if the plan is ambiguous rather than guessing.
4. Construct the user message: include the plan, the workspace path, and a brief snapshot of git state.
5. Dispatch via `transport.sendCompletion()` in interactive (multi-turn) mode. Stream output to the user.
6. **Confirmation gate:** before applying the first file write, surface a yes/no confirmation to the user with a preview of the proposed change. No silent codebase mutation, ever.
7. After the rescue completes, run `git status --porcelain` and surface the diff summary so the user can decide whether to commit or revert.

## Constraints

- Mutates the codebase. The first-write confirmation gate is non-negotiable in v1.
- `/codex:rescue` is execution, not planning. If the user's request reads like "design the system for X", redirect them to Claude's plan mode and only invoke Codex once a plan exists.
- Codex is allowed to write files only under the workspace root. Path normalization (`scripts/util/paths.ts`) ensures we don't accidentally escape via `..` or absolute paths to user home.
- Every write goes through the same redacted log path; tokens never leave the auth subsystem.
