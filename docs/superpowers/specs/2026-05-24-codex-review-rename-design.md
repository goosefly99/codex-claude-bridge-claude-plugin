# Design: Codex review command rename + general-purpose review

**Date:** 2026-05-24
**Status:** Approved (user invoked /superpowers:brainstorming with explicit "work without stopping" directive; design surfaced to user before implementation began.)
**Author/Driver:** oliver.biele@oneilglobaladvisors.com
**Trigger:** A session that wanted Codex to look at `docker/jupyterhub/` could not — `/codex:review` is hard-wired to a base/head git diff, with no `--path` or "answer this question" flag. The command's name promises generality the implementation does not deliver.

## Objective

Make the codex-claude-bridge plugin's review surface match its names. Diff-scoped review keeps its current behavior under a new, accurate name. The `review` name is reclaimed for a general-purpose review of arbitrary filesystem content.

## Constraints

- Existing transport layer, sizeClassifier, jobManager, prompts, and schemas must be reused. No new HTTP path, no new auth flow.
- The 7-attack-surface taxonomy (in `prompts/adversarial-system.md`) is locked and must stay locked. The anti-drift test must continue to pass.
- Background/--wait flag semantics must be preserved across all four commands.
- No new bind mounts, no new dependencies on developer-local paths. (CLAUDE.md hard veto.)
- Verification gate: typecheck, lint, build, full test suite must pass before declaring done.

## Final command surface

Two axes — scope (diff vs. arbitrary filesystem content) × tone (neutral vs. adversarial). Four commands:

| Command | Scope | Tone | Target arg |
|---|---|---|---|
| `/codex:diff-review` | Working diff or `<git-ref>` | Neutral | Optional git ref |
| `/codex:adversarial-diff-review` | Working diff or `<git-ref>` | Adversarial (7 surfaces, structured JSON) | Optional git ref |
| `/codex:review` | Arbitrary files/folders | Neutral | Required `<path...>` |
| `/codex:adversarial-review` | Arbitrary files/folders | Adversarial (7 surfaces, structured JSON) | Required `<path...>` |

Untouched commands: `/codex:setup`, `/codex:status`, `/codex:rescue`.

### Why no overloaded single command

Considered making `/codex:review` accept both `<git-ref>` and `--path <path>`. Rejected because:
- It hides the cost difference (diff = small, folder walk = potentially the full token budget).
- It makes the no-arg default ambiguous: do you mean "current diff" or "current directory"?
- The error a user sees today ("/codex:review is hard-wired to diff review") proves the implementation is already two different things; surfacing that as two named commands is honest.

## Engine changes

### New helper: `collectFilesystemContext(paths, opts)`

Lives in `scripts/codex/fsContext.ts` (new file). Responsibilities:

- Resolve each input path (file or directory). Reject paths that escape the repo root or resolve to absolute paths outside the cwd, to keep the surface small. (Out of repo is a v0.3 extension if requested.)
- For directories, walk recursively. Apply `.gitignore` via `git check-ignore` (the repo's existing dependency on git is already in `greenfield.ts` and `adversarialEngine.ts`) — fall back to a small built-in deny-list (`node_modules`, `dist`, `.git`, `.acv`, binary extensions) when not in a git repo.
- Approximate tokens via the existing `approximateTokens(text)` helper (chars/4) and stop adding files once `config.context_token_budget` would be exceeded. Surface a `truncated: true` flag and a list of `skipped: string[]` paths in the return value so the user prompt can disclose what was omitted.
- Return `{ files: Map<relativePath, content>, totalTokens, truncated, skipped }`.

### New engine functions in `scripts/codex/adversarialEngine.ts`

- `runGeneralReview(paths, opts)` — neutral. Loads `prompts/review-system.md`, prepends a one-paragraph framing block ("you are reviewing the following filesystem content, not a diff") so the existing system prompt stays single-source-of-truth, calls `collectFilesystemContext`, builds the user prompt as a sequence of fenced file blocks plus the user's optional `--question`, dispatches via `sendCompletion`. Returns prose.
- `runGeneralAdversarialReview(paths, opts)` — adversarial. Same shape, but loads `prompts/adversarial-system.md` (locked) and `schemas/adversarial-output.json` validation. The 7-surface taxonomy is unchanged; only the input shape changes (filesystem content instead of diff).
- The existing `runNeutralReview` and `runAdversarialReview` are renamed to `runDiffReview` and `runAdversarialDiffReview` for symmetry. (`runAdversarialReview` is the function exported elsewhere — call sites updated.)

### Prompts

Single source of truth per tone. `prompts/review-system.md` and `prompts/adversarial-system.md` stay locked. The framing ("you are reviewing a diff" vs. "you are reviewing filesystem content") is prepended at call time as a one-paragraph user-message preamble. This avoids near-duplicate prompt files that would drift.

## CLI changes

Four CLIs under `scripts/codex/`:

| CLI file | Command | Engine function |
|---|---|---|
| `cli-diff-review.ts` (renamed from `cli-review.ts`) | `/codex:diff-review` | `runDiffReview` |
| `cli-adversarial-diff-review.ts` (renamed from `cli-adversarial.ts`) | `/codex:adversarial-diff-review` | `runAdversarialDiffReview` |
| `cli-review.ts` (new) | `/codex:review` | `runGeneralReview` |
| `cli-adversarial-review.ts` (new) | `/codex:adversarial-review` | `runGeneralAdversarialReview` |

The two new general CLIs:
- Require at least one positional `<path>`. If none supplied, exit non-zero with a message: "no paths given — did you mean `/codex:diff-review`? Use `/codex:review <path...>` to review files or folders."
- Accept `--effort`, `--background`, `--wait` (same semantics as the diff commands).
- Accept `--question "..."` to focus Codex on a specific concern. The question is included as a user-prompt preamble.
- Adversarial general CLI additionally accepts `--focus <surface>` (one of the 7 attack surfaces) — same semantics as the diff command.

Background spawn: the existing `spawnDetached` + `CODEX_BRIDGE_JOB_ID` pattern is reused verbatim. Each CLI passes its own command label (`codex:review`, `codex:diff-review`, etc.) into `writeJobResult` for the status command.

## Manifest changes

- `commands/review.md` → `commands/diff-review.md` (front-matter `name: codex:diff-review`).
- `commands/adversarial-review.md` → `commands/adversarial-diff-review.md` (front-matter `name: codex:adversarial-diff-review`).
- New `commands/review.md` (general-purpose, front-matter `name: codex:review`).
- New `commands/adversarial-review.md` (general-purpose, front-matter `name: codex:adversarial-review`).
- `plugin.json` description and `package.json` keywords updated to list six (not five) commands.
- `marketplace.json` ditto.

## Docs changes

- `README.md`: command table updated; "Renamed in v0.2.0" callout under the table; examples updated to use new names.
- `AGENTS.md`: the "No synonyms, no rebranding" muscle-memory rule gets a one-paragraph exception note: the old `review` name was actively misleading (users with unrelated working diffs got a review of the wrong files), and that beats muscle memory. The exception is scoped to this rename; the rule otherwise stands.
- `HANDOFF.md`: examples updated.
- `prompts/rescue-system.md` and `prompts/review-system.md` back-references updated.
- `docs/use-case-patterns.md`: updated where it names `/codex:adversarial-review`.

## Test changes

- `tests/anti-drift.test.ts`: the 7-surface lock test stays as-is (the locked prompt file is unchanged). Add coverage that `runGeneralAdversarialReview` loads the same locked prompt path.
- `tests/skill-trigger-shape.test.ts`: update any string assertions that mention the old command names.
- `tests/background-spawn.test.ts`: update command labels passed to `writeJobResult`.
- New `tests/fs-context.test.ts`: covers `collectFilesystemContext` — file vs. directory input, `.gitignore` exclusion, deny-list fallback when not in git, token cap with `truncated: true` and `skipped` list.
- New `tests/general-review-cli.test.ts`: covers the no-paths error message on both general CLIs.

## Non-goals

- No alias commands (the rename is hard; users adapt).
- No cross-repo path support yet (paths must be inside cwd).
- No image / non-text file support (binary deny-list filters them out).
- No streaming output for general review.
- `rescue`, `setup`, `status` are not renamed.

## Acceptance criteria

1. `npx tsc --noEmit` clean.
2. `npx eslint . --quiet` clean.
3. `npm run build` succeeds; `dist/codex/` contains four CLI entries matching the new layout.
4. `npm test` passes including new tests.
5. `grep -rn "codex:review " --include="*.md" --include="*.ts" --include="*.json"` in non-dist, non-node_modules, non-.acv paths returns only references where `codex:review` is the *new* general command, or where the literal string is intentionally preserved in a "renamed from" note.
6. `/codex:review docker/jupyterhub/` would (if dispatched) ship Codex the contents of that folder and a request for a neutral review — not a diff of unrelated working-tree files.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Muscle-memory break for current `/codex:review` users | Clear v0.2.0 callout in README; explicit error message on the new commands that hints at the renamed sibling when args don't fit. |
| `/codex:adversarial-review <no-args>` previously meant "current diff"; now errors | The no-args error message names `/codex:adversarial-diff-review` explicitly so the fix is one keystroke for the affected user. |
| Folder walk balloons context | Reuse the existing `context_token_budget`; surface `truncated: true` and `skipped: string[]` so the user knows what was dropped. |
| Drift between four CLI files | All four delegate to engine functions in `adversarialEngine.ts`; CLIs are thin argument-parsing wrappers only. |
| Prompt drift between diff and general framing | Single source of truth per tone (`review-system.md`, `adversarial-system.md`). Framing is prepended at call time, not duplicated to separate prompt files. |
