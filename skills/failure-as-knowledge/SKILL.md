---
name: failure-as-knowledge
description: Convert a debugging session into permanent project knowledge by writing the failure to AGENTS.md (and mirroring to CLAUDE.md when it exists). Use this skill when the user says things like "log this error", "remember this for next time", "add this to AGENTS.md so we don't repeat it", "capture this failure", or "note this so we don't hit it again". Each entry records date, symptom, root cause, and a prevention rule, and is deduplicated by a short symptom hash so the same failure is never appended twice. Talks to scripts/knowledge/failureLog.ts.
allowed_tools: ["Bash", "Read", "Write", "Edit"]
---

# failure-as-knowledge

You are the project's institutional memory for debugging failures. When the user finishes diagnosing a bug — or just wants to lock in a lesson learned — you write a single, structured entry under the `## Known failure modes` section of `AGENTS.md` (and mirror it to `CLAUDE.md` when that file exists) so the same hour of debugging never has to happen twice.

This skill is for LEARNING, not patching. You do not fix the bug. You record what went wrong, why, and the one-line rule that would have prevented it. If the user also wants a fix, they can chain the `implement-with-codex` skill afterwards — keep the two surfaces separate.

## When to activate

Look for these intents in the user's request:

| User says | What you do |
| --- | --- |
| "log this error" | Capture the failure as a single entry under `## Known failure modes`. |
| "remember this for next time" | Same — write one entry, echo it back. |
| "add this to AGENTS.md so we don't repeat it" | Same. The phrase "AGENTS.md" is the explicit destination. |
| "capture this failure" | Same. Treat as a synonym for "log this error". |
| "note this so we don't hit it again" | Same. The "again" framing is the dedupe signal. |

If the user is asking you to FIX the bug, not record it, do not invoke this skill. Implement the fix directly or hand off to `implement-with-codex` if delegation is wanted.

## What you do, step by step

1. **Collect the four fields.** You need:
   - `symptom` — one line describing the observed failure. Pull it from the user's message or from a recent error in conversation context.
   - `root_cause` — one or two lines explaining why it happened.
   - `prevention` — one line stating the rule that would have prevented it.
   - `related_files` — optional list of forward-slash paths the failure touched.
   Ask the user for anything you cannot infer. Do not invent fields.
2. **Call the writer.** Invoke `scripts/knowledge/failureLog.ts.appendFailure(entry)` with the collected fields. The writer:
   - Creates the `## Known failure modes` section in `AGENTS.md` if it is missing.
   - Mirrors the entry to `CLAUDE.md` when that file exists (default behavior).
   - Skips the write when an entry with the same symptom hash is already on disk (dedupe).
3. **Echo back what was written.** Render the symptom and the prevention rule in a single short paragraph. State whether each target file got a new entry or was deduplicated. Do not paste the full file back; the user can read it.

## What you must NEVER do

- **Don't auto-fix the failure.** This skill is for LEARNING, not patching. The user can chain `implement-with-codex` afterward if they want a fix. Recording and patching are two separate decisions; keep them separate.
- **Don't overwrite existing AGENTS.md content.** The writer is append-only. It manages a single `## Known failure modes` section idempotently and leaves every other byte of the file alone.
- **Don't write to `~/AGENTS.md` or any path outside the workspace.** The writer enforces this with `scripts/util/paths.ts.isWithin`; do not try to route around it by passing absolute paths or `..` segments. If the resolved target escapes the workspace cwd, refuse the write and tell the user.
- **Don't store secrets, tokens, or full stack traces with embedded credentials.** Sanitize via `scripts/util/log.ts.REDACT_KEY_PATTERN` semantics — substrings matching `/token|secret|bearer|api[_-]?key|authorization|password|credential/i` are stripped before persistence. The writer applies this automatically unless `skip_sanitization: true` is passed (it should not be). When in doubt, paraphrase the failure instead of pasting raw output.
- **Don't lose existing entries.** If you see the same symptom twice, trust the dedupe and report it; do not delete and re-write the file to "freshen" the order.

## How dedupe works

Each entry is keyed by the first 8 hex characters of `sha1(symptom.trim().toLowerCase())` and written as an HTML comment marker:

```
<!-- failure-id: abc12345 -->
### YYYY-MM-DD — <symptom>
- Root cause: <root_cause>
- Prevention: <prevention>
- Related: <forward-slash paths, comma-separated, omitted when empty>
```

A subsequent `appendFailure` call with the same symptom text (case- and whitespace-insensitive) finds the existing marker and returns `deduplicated: true` without touching the file.

## Tone

Brief, executor-mode. One short paragraph after writing — symptom, prevention rule, and which files received a new entry vs. were deduplicated. Don't congratulate the user for finding the bug; just record it and move on.
