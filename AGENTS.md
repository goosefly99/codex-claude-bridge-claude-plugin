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

### 3. Single-job concurrency is ENFORCED for slash commands.
`scripts/concurrency/jobManager.ts` keeps exactly one Codex job in flight per workspace **for the slash-command registry**, with a FIFO depth-1 queue. The `implement-with-codex` skill is the only sanctioned multi-job pathway, routed through `scripts/codex/delegator.ts` against a separate `delegator` registry namespace inside the same job manager. The two registries are tracked independently; `/codex:status` surfaces both.

Do not "lift" the slash-command depth-1 FIFO; do not "tighten" the delegator pathway. The split is deliberate: user-typed commands stay observable and predictable, while agentic delegation can run N parallel Codex agents up to `config.delegator_max_concurrent` (default 4). If you want to relax the slash-command invariant, do it in v2 with a separate RFC.

### 4. Command names match the OpenAI reference plugin verbatim.
`/codex:setup`, `/codex:review`, `/codex:adversarial-review`, `/codex:rescue`, `/codex:status`. No synonyms, no rebranding. Users are switching between two plugins; muscle memory is the feature.

The `implement-with-codex` skill is NOT a slash command — it is an agentic skill (lives in `skills/implement-with-codex/SKILL.md`) that Claude invokes when the user describes a delegation intent. It does not consume the `/codex:` namespace.

### 5. The plugin is NEVER positioned as a planner.
Marketing copy, command descriptions, and prompts must always frame Codex as the **executor or reviewer**, with Claude doing the planning. This is a positioning decision (DI-7) backed by the source material — Codex's reasoning style is excellent for QA but mid for open-ended planning.

### 6. Windows paths get first-class testing.
`scripts/util/paths.ts` is the only sanctioned source of path normalization. Every component that touches a path goes through it. The reference plugin shipped with a Windows path bug within days of release; this is the lesson we learned for free.

---

## The `implement-with-codex` skill — design notes

The skill (`skills/implement-with-codex/SKILL.md`) is the **only agentic delegation surface**. Slash commands stay synchronous, predictable, and depth-1; the skill is what lets Claude orchestrate multiple Codex agents for the higher-level patterns (P1 plan→execute, P3 plan→audit→implement, P4 A/B, P5 split, P7 ralph).

Routing rules:

- The skill bypasses `/codex:rescue` entirely. It talks to `scripts/codex/delegator.ts`, which in turn calls `scripts/codex/transport.ts.sendCompletion()` directly. This is deliberate — the rescue command targets a single human-typed handoff, while the skill targets autonomous multi-agent orchestration.
- The skill MUST go through `delegator.ts` rather than calling `transport.ts` directly from skill prose. The delegator is where path normalization, redacted logging, confirmation gates, and the dual-registry concurrency live. Skill prose is for *Claude's* decision logic.
- Confirmation gates on writes are NOT optional. The delegator enforces a first-write confirmation per spawned agent unless explicitly suppressed via `DelegateOptions.confirm: false`, and even then the suppression is logged (so an operator can audit).
- Worktree isolation (`config.delegator_isolate_worktrees`) is opt-in. When enabled, A/B and Ralph patterns get their own throwaway worktree per agent so parallel writes don't collide. Off by default — most users will run the skill against the main working tree.

What the skill must NEVER do:

- Generate the 7 attack-surface taxonomy on the fly. (Same invariant as everywhere else.) If a delegation includes an adversarial-review step, it must invoke `adversarialEngine.runAdversarialReview()`, which loads the locked prompt.
- Skip the path-normalization layer. All file writes routed through the delegator pass through `scripts/util/paths.ts`.
- Mutate the slash-command job registry. The dual-registry split is non-negotiable.
- Auto-commit. The skill always leaves the diff in the working tree and tells the user to review before committing.

## The Codex-methods skill suite (`adversarial-plan-review`, `browser-verify`, `failure-as-knowledge`, `agents-md-sync`)

Four additional skills derived from `concepts/codex_methods/`. Each is independent, narrow, and triggered by phrase-matching against its SKILL.md description. None of them route through `delegator.ts` — they are orthogonal to the implement-with-codex pathway. Design rules per skill:

- **`adversarial-plan-review`** is the plan-stage analog of `/codex:adversarial-review`. It uses `scripts/codex/planReviewer.ts` against `prompts/plan-review-system.md` (LOCKED) with the 6-category taxonomy (missing-requirement, hidden-assumption, scope-creep, security-blind-spot, integration-gap, observability-gap). The 6 categories are enforced by an anti-drift test in `tests/plan-reviewer.test.ts` — same protection model as the 7 attack surfaces. Output validates against `schemas/plan-review-output.json`. Loop terminates on `verdict_acceptable`, `severity_converged` (5-point tolerance), `unfit_short_circuit`, or `max_iterations`.

- **`browser-verify`** is READ-ONLY. It never writes code. `scripts/browser/verify.ts.detectBackend()` probes for Playwright MCP > Codex Chrome plugin > `@browseruse` > none-with-install-instructions. The skill itself uses whichever backend the user has — the plugin doesn't ship a browser driver. The five recipes live in `skills/browser-verify/playwright-recipes.md` and are referenced by name from the skill body.

- **`failure-as-knowledge`** writes to `AGENTS.md` (and mirrors to `CLAUDE.md` when present) under a managed `## Known failure modes` section. Dedup via SHA-1 of `symptom.trim().toLowerCase()` first 8 hex, persisted as `<!-- failure-id: <hash> -->` HTML comments. Sanitization runs `token=…`, `secret=…`, `bearer …`, `api[_-]?key=…`, `password=…`, `authorization` substring replacements before write. Path-escape refusal via `paths.isWithin(cwd)`.

- **`agents-md-sync`** owns the LEAN schema for AGENTS.md (5 sections: User identity, Project goal, Style preferences, Standing rules, Known failure modes). Critical invariant: any section tagged `<!-- managed-by: X -->` is preserved verbatim from the destination during mirror operations. This is how the `failure-as-knowledge` section survives an `agents-md-sync` mirror — neither skill knows about the other; both honor the marker. Do not break the marker convention.

What this suite must NEVER do:

- Generate the 6 plan-review categories (or the 7 attack surfaces) on the fly. Both prompts are LOCKED.
- Write outside the workspace root. `paths.isWithin(cwd)` guards every disk write that takes a user-supplied path.
- Auto-commit. Any tracked-file modification (AGENTS.md, CLAUDE.md, working tree) is left for the user to commit.
- Cross-write into the other skill's domain. `failure-as-knowledge` ONLY writes to its managed section; `agents-md-sync` NEVER touches managed sections.

## Testing strategy

- **Unit tests** under `tests/` use vitest. Run with `npm test`.
- **Anti-drift tests** are the most important tests in the suite. Two of them:
  - `tests/anti-drift.test.ts` — the 7 attack surface names are verbatim in `prompts/adversarial-system.md`.
  - `tests/plan-reviewer.test.ts` — the 6 plan-review categories are verbatim in `prompts/plan-review-system.md`.
  Neither test may be disabled.
- **Skill-trigger shape tests** verify the canonical activation phrases are present verbatim in each SKILL.md (`skill-trigger-shape.test.ts`, `browser-verify-trigger-shape.test.ts`, and the trigger-phrase blocks inside `plan-reviewer.test.ts`, `failure-log.test.ts`, `agents-md-sync.test.ts`). These guard against silent regressions when a skill description is "polished".
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
  skills/                  # Agentic skills (C10, C11) — implement-with-codex, adversarial-plan-review, browser-verify, failure-as-knowledge, agents-md-sync
  scripts/auth/            # OAuth + token cache (C2)
  scripts/browser/         # Browser-backend detection + report formatting (C11)
  scripts/codex/           # Transport, adversarial engine, classifier, delegator, plan reviewer (C3, C6, C7, C10, C11)
  scripts/concurrency/     # Job manager — dual registry (C5)
  scripts/git/             # Greenfield handler + optional worktree isolation (C8)
  scripts/knowledge/       # AGENTS.md / CLAUDE.md tooling — failure log + sync (C11)
  scripts/util/            # Paths, logging, config (C9)
  prompts/                 # Locked system prompts (incl. delegator-system.md)
  schemas/                 # JSON schemas for output + config
  tests/                   # Vitest suites
```

Each directory has a single component owner. Cross-directory edits should be split into smaller commits.

## What to never change without explicit human approval

- The 7 attack surface names (anywhere they appear).
- The five command names in `plugin.json` and `commands/*.md`.
- The OAuth-only auth model (no API-key fallback in v1).
- Slash-command depth-1 FIFO in the `commands` registry of `scripts/concurrency/jobManager.ts`. (The `delegator` registry is allowed to run multiple jobs; do not unify the two.)
- The structured-JSON output contract in `schemas/adversarial-output.json` and `schemas/delegator-output.json` (additive changes are okay; removing or renaming fields is not).
- The redaction list in `scripts/util/log.ts`.
- The `implement-with-codex` skill description triggers in `skills/implement-with-codex/SKILL.md` — these are how Claude knows when to invoke the skill. Tweaking them changes when delegation kicks in; do it deliberately, not as a side effect of doc cleanup.
- The canonical trigger phrases in any of the other four skills (`adversarial-plan-review`, `browser-verify`, `failure-as-knowledge`, `agents-md-sync`) — same rule. Each has a shape test that fails loudly if a phrase is dropped.
- The 6 plan-review categories in `prompts/plan-review-system.md` — verbatim, in order. Enforced by `tests/plan-reviewer.test.ts`. Same protection model as the 7 attack surfaces.
- The `<!-- managed-by: X -->` marker convention. `failure-as-knowledge` writes its section under `<!-- managed-by: failure-as-knowledge -->`; `agents-md-sync` preserves any section carrying such a marker verbatim during mirrors. Breaking either side breaks the coexistence guarantee.

## Conventions

- TypeScript strict mode, ESM/NodeNext.
- Every public function has a JSDoc with `@param`, `@returns`, and a one-line summary.
- No `any`. If you reach for it, reach for `unknown` instead and narrow.
- Every file under `scripts/` exports a small interface, not a class with eight methods.
- Errors flow through `ErrorKind` enum in `scripts/util/log.ts` so exit codes stay stable for scripting consumers.

## When in doubt

Open an issue or write a comment in `ROADMAP.md` with `Q:` prefix. Don't quietly weaken an invariant.
