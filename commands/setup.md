---
name: codex:setup
description: Validate your OPENAI_API_KEY and verify the Codex endpoint is reachable. Run this once per machine, or again after rotating your API key.
argument_hint: (no arguments)
allowed_tools: ["Bash", "Read"]
script: ${CLAUDE_PLUGIN_ROOT}/dist/auth/cli-setup.js
---

# /codex:setup

You are running the `codex-claude-bridge` setup command. Auth uses `OPENAI_API_KEY` from the environment (the same key used by the `codex` CLI).

## Steps

1. Check that `OPENAI_API_KEY` is set in the environment. If not, instruct the user to `export OPENAI_API_KEY=sk-...` and exit with code 2.
2. Run a probe call to the Codex endpoint to confirm the key is valid and the endpoint is reachable.
3. Print one of the following exit summaries:
   - On success: `OK — OPENAI_API_KEY validated; endpoint reachable. Try /codex:diff-review (for a git diff) or /codex:review <path...> (for arbitrary files).`
   - On probe failure (network): explain the failure and recommend checking network access to `api.openai.com`.
   - On 401: `OPENAI_API_KEY is invalid or has insufficient permissions.`

## Constraints

- **Never log the key.** All logging routes through `${CLAUDE_PLUGIN_ROOT}/scripts/util/log.ts` which redacts any field matching `/token|secret|bearer|api[_-]?key/i`.
- **Idempotent.** Re-running `/codex:setup` always validates the current key; there is no cached state to reuse.
- **Exit codes:** 0 on success, 2 on auth failure, 4 on network failure.
