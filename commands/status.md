---
name: codex:status
description: Inspect the current background Codex job. Shows command label, state (idle/running/completed-pending-delivery), start time, elapsed seconds, and any FIFO-queued requests.
argument_hint: (no arguments)
allowed_tools: ["Bash", "Read"]
script: ${CLAUDE_PLUGIN_ROOT}/dist/concurrency/cli-status.js
---

# /codex:status

You are running the introspection command. This is read-only: it never mutates state, never calls the Codex API, and never blocks.

## Steps

1. Load the active job registry for the current workspace via `${CLAUDE_PLUGIN_ROOT}/scripts/concurrency/jobManager.ts.current()`.
2. Render one of:
   - `idle` — no job active, no queue. Tell the user they're free to run any command.
   - `running` — surface: command label, started-at (ISO), elapsed seconds, the workspace hash, and (if available) the Codex request ID.
   - `completed-pending-delivery` — surface: command label, completed-at, and a note that the result will auto-deliver as a tool-result on the next session refresh.
3. If the FIFO queue depth is > 0, surface the queued request's command label and queued-at timestamp.
4. Read recent JSONL log entries from `${CLAUDE_PLUGIN_DATA}/codex-bridge/logs/` (current day's file only) and display the last 5 non-debug entries to give the user context for what the running job is doing. Logs are pre-redacted; do NOT re-load raw token bytes.

## Constraints

- Read-only. No writes to the job registry, no API calls.
- If the `${CLAUDE_PLUGIN_DATA}/codex-bridge/jobs/<workspace-hash>/active.json` file is malformed (corrupted, truncated), surface a `path_resolution`-style error and recommend running `/codex:setup` to reinitialize state.
- The output is human-readable text, not JSON. (Plan mode does not need to re-read this command's output.)
