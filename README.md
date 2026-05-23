# codex-claude-bridge

> Two models. One review. Zero blind spots.

A Claude Code marketplace plugin that wraps **OpenAI Codex** (GPT-5.4-class) as an adversarial reviewer and execution-rescue tool, runnable from inside any Claude Code session.

## What it does

`codex-claude-bridge` adds five slash commands to Claude Code:

| Command | Purpose |
| --- | --- |
| `/codex:setup` | Authenticate with your existing ChatGPT account (browser OAuth, no API key). |
| `/codex:review` | Neutral code review of the current diff. |
| `/codex:adversarial-review` | Hostile review across 7 hard-coded attack surfaces. Returns structured JSON. |
| `/codex:rescue` | Hand a Claude-authored plan to Codex for execution. |
| `/codex:status` | Inspect any background Codex job. |

The flagship is `/codex:adversarial-review`. It runs a 6-phase review process and forces Codex to reason through each of seven attack surfaces in a fixed order, emitting structured JSON that Claude plan mode can re-read for closed-loop fix implementation.

## Why it exists

Single-model code review has a structural flaw: **a model cannot reliably evaluate its own work.** When Claude generates code and Claude reviews that code, the same priors that wrote the bug are likely to overlook it. Empirically, Opus and Codex agree on roughly 1 finding in 11 — meaning a dual-model review surfaces ~10× the unique critical issues of either model alone.

This plugin gives Claude Code a second adversarial reviewer that doesn't share Claude's training distribution. You keep using Claude as your planner and primary author; Codex becomes your QA and execution fallback.

## Install

Three steps. Each takes seconds.

```text
/plugin marketplace add https://github.com/TBD/codex-claude-bridge
/plugin install codex-claude-bridge
/codex:setup
```

`/codex:setup` opens your default browser, walks you through ChatGPT OAuth, and caches the resulting token under `$CLAUDE_PLUGIN_DATA/codex-bridge/auth.json` (mode 0600 on Unix; ACL-restricted on Windows). Free, Plus, Pro, Team, and Enterprise ChatGPT tiers all work.

## Commands

### `/codex:setup`
Browser-based OAuth against your ChatGPT account. Run once per machine, or again whenever the cached token expires.

```text
/codex:setup
```

### `/codex:review [--effort low|medium|high] [--background|--wait] [<git-ref>]`
Neutral review of the current diff (uncommitted changes by default; an explicit ref overrides). Auto-classifies based on diff size: small diffs run synchronously, large ones prompt for `--background` or `--wait`.

```text
/codex:review --effort high
/codex:review main..HEAD --background
```

### `/codex:adversarial-review [--effort ...] [--focus <surface>] [--background|--wait] [<git-ref>]`
Hostile review across all 7 attack surfaces by default, or narrowed via `--focus`. Output is JSON validated against `schemas/adversarial-output.json`: verdict, severity buckets, file:line refs, fix hints, next steps, items safe to ship.

```text
/codex:adversarial-review --effort high
/codex:adversarial-review --focus "Race conditions"
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

## Authentication

Authentication is OAuth-only against your existing ChatGPT account. **No OpenAI API key is supported in v1** — that's deliberate, so the free-with-your-subscription value-prop holds. The token is encrypted at rest using the OS keychain when available (`keytar`), with an encrypted file fallback (`sodium-native`).

## Configuration

Edit `$CLAUDE_PLUGIN_DATA/codex-bridge/config.json` to override defaults. Schema lives at `schemas/config.json`. Common keys:

| Key | Default | Description |
| --- | --- | --- |
| `model` | `gpt-5.4-codex` | Model alias used for all commands. |
| `api_base` | `https://api.openai.com/v1` | Codex/Chat Completions endpoint. |
| `diff_files_threshold` | `8` | Files-changed cutoff for sync-vs-bg routing. |
| `diff_loc_threshold` | `500` | LOC-delta cutoff for sync-vs-bg routing. |
| `max_retries` | `3` | Exponential-backoff retry count on 429 / 5xx. |
| `log_level` | `info` | `debug` includes prompt bodies (locally only). |

## Limitations (v1)

- **Single Codex job per workspace.** Concurrent jobs are queued FIFO at depth 1; further enqueues are rejected with a pointer to `/codex:status`. Multi-job concurrency is on the v2 roadmap.
- **Git-only.** Non-git workspaces are out of scope. The greenfield handler creates a throwaway `codex-review-base` branch when no commits exist; non-git directories error out with exit code 3.
- **Windows path handling.** The reference plugin shipped with a Windows path bug. We have a dedicated path-normalization module and a regression test suite, but please file an issue if you hit anything unexpected.
- **No telemetry.** All logs are local. We never phone home.

## License

MIT.
