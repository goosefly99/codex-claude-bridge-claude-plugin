# AGENTS.md

Instructions for AI agents (Claude, Codex, or any other) working on the `codex-claude-bridge` codebase.

Read this file fully before making any edit. The invariants below are not stylistic preferences; they are load-bearing for the plugin's value proposition.

---

## Project mission

Wrap OpenAI Codex inside Claude Code as **an adversarial second reviewer and execution rescue tool** — never as a planner replacement. The wedge is the empirical fact that two models from different training distributions overlap on roughly 1 finding in 11. Erase that and we erase the reason to install the plugin.

## Hard invariants — never relax these

### 1. The 7 attack surfaces are HARD-CODED. Never generated dynamically.
The taxonomy lives verbatim in `prompts/adversarial-system.md`. The names are:

- Authentication
- Data loss
- Rollbacks
- Race conditions
- Degraded dependencies
- Version skew
- Observability gaps

`tests/anti-drift.test.ts` asserts each name is present in the system prompt verbatim. If you change a name, change it in the prompt, the schema, the test, AND the docs in the same commit. Do not delete or rename surfaces without an RFC-style discussion in `ROADMAP.md`.

### 2. OAuth tokens are NEVER logged.
`scripts/util/log.ts` redacts the `Authorization` header, any field whose key matches `/token|secret|bearer|api[_-]?key/i`, and any value matching the OAuth bearer shape. If you add a new logging path, route it through the redactor — do not call `console.log` directly with anything that could carry a token. The audit pass in Phase 5 of `ROADMAP.md` exists specifically to catch this.

### 3. Single-job concurrency is ENFORCED.
`scripts/concurrency/jobManager.ts` keeps exactly one Codex job in flight per workspace, with a FIFO depth-1 queue. Subsequent enqueues are rejected. Do not "improve" this to a deeper queue or unbounded parallelism in v1 — we deliberately chose tight semantics so we can ship a small, observable surface and learn from real usage before adding concurrency. If you want to lift this, do it in v2 with a separate RFC.

### 4. Command names match the OpenAI reference plugin verbatim.
`/codex:setup`, `/codex:review`, `/codex:adversarial-review`, `/codex:rescue`, `/codex:status`. No synonyms, no rebranding. Users are switching between two plugins; muscle memory is the feature.

### 5. The plugin is NEVER positioned as a planner.
Marketing copy, command descriptions, and prompts must always frame Codex as the **executor or reviewer**, with Claude doing the planning. This is a positioning decision (DI-7) backed by the source material — Codex's reasoning style is excellent for QA but mid for open-ended planning.

### 6. Windows paths get first-class testing.
`scripts/util/paths.ts` is the only sanctioned source of path normalization. Every component that touches a path goes through it. The reference plugin shipped with a Windows path bug within days of release; this is the lesson we learned for free.

---

## Testing strategy

- **Unit tests** under `tests/` use vitest. Run with `npm test`.
- **Anti-drift test** (`tests/anti-drift.test.ts`) is the most important test in the suite. It asserts the 7 attack surface names are verbatim in the system prompt. Don't disable it.
- **Windows path tests** must run on a Windows CI runner from day one. OneDrive-redirected user homes, paths with spaces, drive-letter case differences, and UNC paths are all covered by fixtures.
- **Closed-loop integration test** (Phase 3) verifies that `/codex:adversarial-review` JSON output round-trips through Claude plan mode without truncation or paraphrase. If this regresses, P2/P3/P7 patterns degrade silently.

## File map

```
codex-claude-bridge/
  plugin.json              # Plugin manifest (C1)
  marketplace.json         # Marketplace registration (C1)
  README.md                # User-facing docs
  AGENTS.md                # This file
  ROADMAP.md               # Phased delivery plan
  config.json              # Default plugin config
  package.json             # Node deps + scripts
  tsconfig.json            # Strict TS config
  commands/                # Slash command markdown (C4)
  scripts/auth/            # OAuth + token cache (C2)
  scripts/codex/           # Transport, adversarial engine, classifier (C3, C6, C7)
  scripts/concurrency/     # Job manager (C5)
  scripts/git/             # Greenfield handler (C8)
  scripts/util/            # Paths, logging, config (C9)
  prompts/                 # Locked system prompts
  schemas/                 # JSON schemas for output + config
  tests/                   # Vitest suites
```

Each directory has a single component owner. Cross-directory edits should be split into smaller commits.

## What to never change without explicit human approval

- The 7 attack surface names (anywhere they appear).
- The five command names in `plugin.json` and `commands/*.md`.
- The OAuth-only auth model (no API-key fallback in v1).
- Single-job concurrency in `scripts/concurrency/jobManager.ts`.
- The structured-JSON output contract in `schemas/adversarial-output.json` (additive changes are okay; removing or renaming fields is not).
- The redaction list in `scripts/util/log.ts`.

## Conventions

- TypeScript strict mode, ESM/NodeNext.
- Every public function has a JSDoc with `@param`, `@returns`, and a one-line summary.
- No `any`. If you reach for it, reach for `unknown` instead and narrow.
- Every file under `scripts/` exports a small interface, not a class with eight methods.
- Errors flow through `ErrorKind` enum in `scripts/util/log.ts` so exit codes stay stable for scripting consumers.

## When in doubt

Open an issue or write a comment in `ROADMAP.md` with `Q:` prefix. Don't quietly weaken an invariant.
