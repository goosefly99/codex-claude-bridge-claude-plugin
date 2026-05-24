# codex-claude-bridge

> Two models. One review. Zero blind spots.

A Claude Code marketplace plugin that wraps **OpenAI Codex** (gpt-5.5) as an adversarial reviewer and execution-rescue tool, runnable from inside any Claude Code session.

## What it does

`codex-claude-bridge` adds seven slash commands to Claude Code:

| Command | Purpose |
| --- | --- |
| `/codex:setup` | Validate your `OPENAI_API_KEY` and verify the endpoint is reachable. |
| `/codex:diff-review` | Neutral code review of a git diff. |
| `/codex:adversarial-diff-review` | Hostile review of a git diff across 7 hard-coded attack surfaces. Returns structured JSON. |
| `/codex:review` | Neutral review of arbitrary files or folders (not a diff). |
| `/codex:adversarial-review` | Hostile review of arbitrary files or folders across the same 7 attack surfaces. Returns structured JSON. |
| `/codex:rescue` | Hand a Claude-authored plan to Codex for execution. |
| `/codex:status` | Inspect any background Codex job. |

> **Renamed in v0.2.0.** The previous `/codex:review` and `/codex:adversarial-review` were hard-wired to a git diff and produced confusing output when the user's question was about an unrelated folder. They have been renamed to `/codex:diff-review` and `/codex:adversarial-diff-review`. The `/codex:review` and `/codex:adversarial-review` names now belong to general-purpose commands that review arbitrary files or folders.

The flagship is `/codex:adversarial-diff-review` (for diffs) and its sibling `/codex:adversarial-review` (for arbitrary content). Both run the same 6-phase review process and force Codex to reason through each of seven attack surfaces in a fixed order, emitting structured JSON that Claude plan mode can re-read for closed-loop fix implementation.

## Why it exists

Single-model code review has a structural flaw: **a model cannot reliably evaluate its own work.** When Claude generates code and Claude reviews that code, the same priors that wrote the bug are likely to overlook it. Empirically, Opus and Codex agree on roughly 1 finding in 11 — meaning a dual-model review surfaces ~10× the unique critical issues of either model alone.

This plugin gives Claude Code a second adversarial reviewer that doesn't share Claude's training distribution. You keep using Claude as your planner and primary author; Codex becomes your QA and execution fallback.

## Install

Three steps. Each takes seconds.

```text
/plugin marketplace add https://github.com/goosefly99/codex-claude-bridge-claude-plugin
/plugin install codex-claude-bridge
/codex:setup
```

Before running `/codex:setup`, export your OpenAI API key:

```text
export OPENAI_API_KEY=sk-...
```

`/codex:setup` validates the key and confirms the endpoint is reachable. The same key used by the `codex` CLI works here — no separate setup needed if you already have `codex` configured.

## Commands

### `/codex:setup`
Validates `OPENAI_API_KEY` and probes the Codex endpoint. Run once per machine, or again after rotating your key.

```text
/codex:setup
```

### `/codex:diff-review [--effort low|medium|high] [--background|--wait] [<git-ref>]`
Neutral review of a git diff (uncommitted changes by default; an explicit ref overrides). Auto-classifies based on diff size: small diffs run synchronously, large ones prompt for `--background` or `--wait`.

```text
/codex:diff-review --effort high
/codex:diff-review main..HEAD --background
```

### `/codex:adversarial-diff-review [--effort ...] [--focus <surface>] [--background|--wait] [<git-ref>]`
Hostile review of a git diff across all 7 attack surfaces by default, or narrowed via `--focus`. Output is JSON validated against `schemas/adversarial-output.json`: verdict, severity buckets, file:line refs, fix hints, next steps, items safe to ship.

```text
/codex:adversarial-diff-review --effort high
/codex:adversarial-diff-review --focus "Race conditions"
```

### `/codex:review [--effort ...] [--question <text>] [--background|--wait] <path...>`
Neutral review of arbitrary files or folders. Walks each path (respecting `.gitignore`), skips binaries, caps at the configured token budget, and includes the user's optional `--question` as a steering directive.

```text
/codex:review docker/jupyterhub/
/codex:review src/api/ --question "is the retry logic correct under partial network failures?"
```

### `/codex:adversarial-review [--effort ...] [--focus <surface>] [--question <text>] [--background|--wait] <path...>`
Hostile review of arbitrary files or folders using the same 7-attack-surface taxonomy as `/codex:adversarial-diff-review`. Same JSON output shape; only the input is different.

```text
/codex:adversarial-review docker/jupyterhub/
/codex:adversarial-review src/auth/ --focus "Authentication"
```

### `/codex:rescue <plan-or-task>`
Hand Codex a plan and let it execute. Mutates the working tree, so the first write requires explicit user confirmation.

```text
/codex:rescue "Implement the migration plan Claude wrote in the previous turn."
```

### `/codex:status`
Show the current background job, elapsed time, and any queued requests.

```text
/codex:status
```

## Skills

Beyond the five slash commands, `codex-claude-bridge` ships five agentic skills that Claude invokes automatically when your request matches their triggers. You never type their names — describe what you want and Claude routes to the right one.

| Skill | Triggers on phrases like | What it does |
| --- | --- | --- |
| `implement-with-codex` | "use codex to implement", "delegate this to codex", "A/B with codex", "ralph loop with codex" | Hands implementation to 1+ Codex agents in parallel (patterns P1/P3/P4/P5/P7). See section below. |
| `adversarial-plan-review` | "review my plan", "pressure-test this plan before I code", "find the gaps in my plan", "kashef loop on this plan" | Runs Codex against a *written plan* (not code) across 6 categories. Loops ≤3× or until severity decreases. Catches scope mistakes no later test can recover. |
| `browser-verify` | "verify the UI", "click through this", "did my UI changes work", "smoke-test the dashboard" | Drives the browser to confirm UI actually works. Uses Playwright MCP, `@browseruse`, or the Codex Chrome plugin (whichever you have installed). |
| `failure-as-knowledge` | "log this error", "remember this for next time", "add this to AGENTS.md so we don't repeat it" | Appends a deduped, sanitized entry to `AGENTS.md` (and mirrors to `CLAUDE.md` if present). Converts debugging time into permanent project knowledge. |
| `agents-md-sync` | "bootstrap AGENTS.md", "sync AGENTS.md with CLAUDE.md", "lean agents.md for this project" | Bootstraps or syncs `AGENTS.md` ↔ `CLAUDE.md` with a lean 5-section schema. Always preserves `failure-as-knowledge`-managed sections. |

### `implement-with-codex`

Hand implementation work to one or more Codex agents in parallel. This is the higher-level orchestration surface; it bypasses `/codex:rescue` and routes through a dedicated `delegator` so it can run multiple Codex sub-jobs simultaneously without conflicting with the depth-1 FIFO that protects the slash commands.

You don't invoke the skill by name. Claude picks it up when you say things like:

| You say | Skill picks the pattern |
| --- | --- |
| "Use Codex to implement this" | P1 — plan with Claude, execute with Codex |
| "Have Codex implement this, then adversarial-review it" | P3 — plan → audit → implement closed loop |
| "Run both Claude and Codex on this in parallel" | P4 — A/B implementation split |
| "Split this: Codex does the data layer, Claude does the UI" | P5 — workload-fraction split |
| "Ralph loop this with Codex as the reviewer" | P7 — generator + evaluator |

Default parallelism cap is 4 (tune via `delegator_max_concurrent` in `config.json`). For A/B and Ralph runs that mutate code, set `delegator_isolate_worktrees: true` to give each agent its own throwaway worktree — the main working tree stays untouched until you merge.

The skill never auto-commits. It produces a clean diff in your working tree, prints a summary, and leaves the decision to ship to you.

### `adversarial-plan-review`

Run Codex against a written plan **before** any code exists. The skill walks Codex through six categories in order — missing-requirement, hidden-assumption, scope-creep, security-blind-spot, integration-gap, observability-gap — and returns a structured verdict (`acceptable` / `needs-revision` / `unfit`) with severity, gaps, mitigations, and revision hints.

If the verdict isn't `acceptable`, the skill produces a revised plan and re-reviews, up to 3 iterations or until severity stops decreasing. Distinct from `/codex:adversarial-review` and `/codex:adversarial-diff-review`, which run on code; this runs on the plan.

```text
You: "review my plan: <pastes plan>"
Claude (via skill): runs Codex review → presents 4 gaps → produces revised plan → re-reviews → verdict acceptable → done.
```

Source: Mark Kashef's Bitly demo (`concepts/codex_methods/`). Catches scope mistakes that no test suite added later can recover.

### `browser-verify`

After any UI change, ask Claude to verify it visually. The skill probes for one of three backends — Playwright MCP (preferred), the Codex Chrome plugin, or the `@browseruse` mention macro — and drives the browser through one of five named recipes (`smoke-routes`, `primary-cta-clickthrough`, `form-roundtrip`, `dark-mode-toggle`, `network-failure-degradation`).

This skill never writes code. It only verifies and reports `[BLOCKER]` / `[WARN]` / `[OK]` findings. If no backend is installed, it prints Playwright MCP install instructions and stops.

### `failure-as-knowledge`

When you hit an error you don't want to hit again, tell Claude. The skill writes a structured entry to `AGENTS.md` (and `CLAUDE.md` if it exists) under a managed `## Known failure modes` section, deduped by symptom hash so the same error never gets logged twice. Token-like substrings are auto-sanitized before write.

```text
You: "log this error so we don't hit it again. Symptom: dev server fails on port 3000.
     Root cause: another process holds the port. Prevention: free the port first."
Claude (via skill): appends entry → "Wrote to AGENTS.md and CLAUDE.md."
```

### `agents-md-sync`

Bootstraps a lean `AGENTS.md` (auto-loaded by Codex at session start) or syncs an existing one with `CLAUDE.md`. The lean schema has five sections: User identity, Project goal, Style preferences, Standing rules, Known failure modes. Anything reproducible from the codebase stays out — Codex reads the code already.

Always preserves any section tagged `<!-- managed-by: X -->`, so `failure-as-knowledge` entries never get clobbered by a mirror.

## Authentication

Authentication uses your `OPENAI_API_KEY` environment variable — the same key the `codex` CLI uses. Set it in your shell before running `/codex:setup`. The key is read at call time and never persisted to disk by the plugin.

## Configuration

Edit `$CLAUDE_PLUGIN_DATA/codex-bridge/config.json` to override defaults. Schema lives at `schemas/config.json`. Common keys:

| Key | Default | Description |
| --- | --- | --- |
| `model` | `gpt-5.5` | Model alias used for all commands. |
| `api_base` | `https://api.openai.com/v1` | Codex/Chat Completions endpoint. |
| `diff_files_threshold` | `8` | Files-changed cutoff for sync-vs-bg routing. |
| `diff_loc_threshold` | `500` | LOC-delta cutoff for sync-vs-bg routing. |
| `max_retries` | `3` | Exponential-backoff retry count on 429 / 5xx. |
| `log_level` | `info` | `debug` includes prompt bodies (locally only). |
| `delegator_max_concurrent` | `4` | Max Codex sub-jobs the `implement-with-codex` skill runs at once. |
| `delegator_isolate_worktrees` | `false` | If true, A/B and Ralph delegations spawn each agent in its own throwaway worktree. |

## Limitations (v1)

- **Slash commands run single-job per workspace.** Concurrent slash-command jobs are queued FIFO at depth 1; further enqueues are rejected with a pointer to `/codex:status`. The `implement-with-codex` skill has its own registry and may run multiple Codex agents in parallel (default cap 4).
- **Diff commands require git.** `/codex:diff-review` and `/codex:adversarial-diff-review` need a git repo. The greenfield handler creates a throwaway `codex-review-base` branch when no commits exist; non-git directories error out with exit code 3. `/codex:review` and `/codex:adversarial-review` work without git — they walk supplied paths directly and fall back to a built-in deny-list when no `.gitignore` is available.
- **General review reads only inside the cwd.** `/codex:review` and `/codex:adversarial-review` refuse paths that resolve outside the current working directory.
- **Windows path handling.** The reference plugin shipped with a Windows path bug. We have a dedicated path-normalization module and a regression test suite, but please file an issue if you hit anything unexpected.
- **No telemetry.** All logs are local. We never phone home.

## License

MIT.
