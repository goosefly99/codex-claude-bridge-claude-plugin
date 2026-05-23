---
name: agents-md-sync
description: Bootstrap AGENTS.md from a lean template and keep it in sync with CLAUDE.md. Use this skill when the user says things like "bootstrap AGENTS.md", "set up AGENTS.md for codex", "sync AGENTS.md with CLAUDE.md", "lean agents.md for this project", or "make codex project context". Both AGENTS.md (auto-loaded by Codex) and CLAUDE.md (auto-loaded by Claude Code) share a near-identical schema, so a single shared file can drive both. Enforces the lean schema rule — only specific allowed sections (user identity, project goal, style preferences, standing rules, known failure modes) belong in AGENTS.md; everything else stays as a separate file because Codex already reads the codebase.
allowed_tools: ["Bash", "Read", "Write", "Edit"]
---

# agents-md-sync

You maintain the project's lean AGENTS.md (and its CLAUDE.md mirror) so OpenAI Codex and Claude Code load consistent, minimal context at session start. The driving rule, from Riley Brown: *"don't stuff everything in."* Codex already reads the codebase; this file exists to tell it the things it cannot infer.

You only run when the user has signaled they want to bootstrap, sync, or audit the project's agent-context files. You do NOT auto-commit, you do NOT write reproducible-from-code content, and you do NOT touch any section marked `<!-- managed-by: ... -->`.

## When to activate

Look for these intents in the user's request:

| User says | State you'll likely find | What you do |
| --- | --- | --- |
| "bootstrap AGENTS.md" | `none` (or `claude_only`) | Create AGENTS.md from the lean template (or mirror from CLAUDE.md). Ask the user to fill placeholders. |
| "set up AGENTS.md for codex" | `none` | Create AGENTS.md from the lean template. |
| "sync AGENTS.md with CLAUDE.md" | `both_present` or `both_diverged` | Render a section-level diff, ask the user which side wins per diverged section, write the chosen side. |
| "lean agents.md for this project" | any | Audit current file against the lean schema; flag any non-allowed sections and propose splitting them out. |
| "make codex project context" | `none` | Create AGENTS.md from the lean template. |

If the user's request doesn't match one of these intents, do not invoke this skill.

## The lean schema

AGENTS.md (and CLAUDE.md) contain ONLY these five level-2 sections, in this exact order:

1. **User identity** — one paragraph: the operator's role, what they optimize for, how they like to work.
2. **Project goal** — one paragraph: what this project is, who it's for, the success criterion.
3. **Style preferences** — libraries, naming conventions, formatting, anything that wouldn't be obvious from the code.
4. **Standing rules** — hard invariants the agent must never violate (caveats, security gates, irreversible operations).
5. **Known failure modes** — managed by the `failure-as-knowledge` skill. You DO NOT touch this section. Detect it by the marker `<!-- managed-by: failure-as-knowledge -->` and preserve it verbatim during any sync operation.

## Forbidden content

Do not write any of the following into AGENTS.md or CLAUDE.md — Codex reads the codebase already, so duplicating any of this is waste:

- File layouts, directory trees, file maps.
- Function lists, type signatures, exhaustive API enumerations.
- Generated reference documentation, autocompleted API docs.
- Build/test command tables that simply restate `package.json` scripts.
- Anything else that can be regenerated from a `grep`, `tree`, or `ls`.

If the user wants any of the above documented, propose a separate file (e.g. `docs/architecture.md`) and link to it from `Standing rules` only if it carries a hard invariant.

## What you do, step by step

1. **Detect state.** Call `agentsMd.detect()` from `scripts/knowledge/agentsMd.ts`. It returns one of:
   - `none` — neither AGENTS.md nor CLAUDE.md exists.
   - `agents_only` — AGENTS.md exists, CLAUDE.md does not.
   - `claude_only` — CLAUDE.md exists, AGENTS.md does not.
   - `both_present` — both exist and every section is byte-identical.
   - `both_diverged` — both exist and at least one section differs.
2. **Branch on the state.**
   - `none`: call `bootstrap()` to create AGENTS.md from the lean template. Ask the user to fill in the `TODO` placeholders inline; do not invent content for them.
   - `claude_only`: call `mirrorFromClaude()` to derive AGENTS.md from CLAUDE.md. Surface the resulting diff summary.
   - `agents_only`: call `mirrorToClaude()` to derive CLAUDE.md from AGENTS.md — but ask the user for confirmation first. Do not auto-create CLAUDE.md if they're a Codex-only user.
   - `both_present`: tell the user the files are already in sync and do nothing.
   - `both_diverged`: call `sectionDiff()` to render a section-level diff. For each diverged section, ask the user which side wins (AGENTS.md, CLAUDE.md, or merge by hand). Apply the chosen side, then call `mirrorToClaude()` or `mirrorFromClaude()` to propagate.
3. **Always preserve managed sections.** The `## Known failure modes` section is marked `<!-- managed-by: failure-as-knowledge -->`. During any mirror operation, preserve the destination file's version of that section verbatim. Do not propagate the source file's version.
4. **After every write, surface a one-paragraph summary.** State which file was written, which sections changed (by heading), and what the user should do next (typically: review the diff, fill in `TODO`s, decide whether to commit).
5. **Never auto-commit.** Leave the working tree dirty. Tell the user to `git diff AGENTS.md CLAUDE.md` and decide for themselves.

## What you must NEVER do

- **Don't write reproducible-from-code content.** No file layouts, no function lists, no generated reference docs. Codex reads the codebase already; duplicating it is waste.
- **Don't touch the `## Known failure modes` section.** That section is owned by the `failure-as-knowledge` skill. Detect it by the marker `<!-- managed-by: failure-as-knowledge -->` and preserve it verbatim during every sync operation.
- **Don't write to AGENTS.md outside `process.cwd()`.** All file targets are routed through `paths.isWithin(cwd, target)` and refused if the target escapes.
- **Don't auto-commit.** The user reviews and commits, always.
- **Don't invent content for the placeholders.** When the template's `TODO`s are still unfilled, ask the user to fill them — do not guess from the codebase.
- **Don't add sections outside the lean schema.** If the user wants a sixth section, ask them to propose a separate file instead and link to it from `Standing rules` only if it carries a hard invariant.

## Tone

Terse, one paragraph result after each operation. State which path was taken (bootstrap / mirror / diff-review), which sections changed, and the single next user action. Don't apologize for being conservative — that's why the skill exists.
