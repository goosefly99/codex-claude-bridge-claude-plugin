# HANDOFF — codex-claude-bridge

> Pick-up doc for completing the v0.1.0 release. Written for a fresh clone on a
> machine where the `codex` CLI is available. Read top-to-bottom — sections are
> ordered by blocking severity, not by intended workflow order.
>
> **Current state:** 152/152 tests passing on `auto_dev` and `main` at commit
> `ac184ae`. All production code is implemented; the gaps below are about
> authentication endpoints, slash-command runtime wiring, background execution,
> and release scaffolding.

---

## §0 — Clone & verify baseline

```bash
git clone https://github.com/goosefly99/codex-claude-bridge-claude-plugin.git
cd codex-claude-bridge-claude-plugin
git checkout auto_dev
npm install
npm run verify
```

Expected: `tsc --noEmit` clean, `eslint` clean, `vitest run` reports
**152 passed**. If anything is red, fix it before continuing — every gap below
assumes a green baseline.

> **Note on `ROADMAP.md`:** the file is gitignored by design
> (`.gitignore:69`). It is local-only per the project-hygiene rule. If you
> need a roadmap on the clone, regenerate it from this handoff.

---

## §1 — BLOCKER: Phase 0 OAuth source-inspection

**Why this blocks everything:** `/codex:setup` cannot complete a real token
exchange. The OAuth constants in `scripts/auth/oauthClient.ts:32-34` are
**provisional guesses**:

```ts
const DEFAULT_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const DEFAULT_TOKEN_URL     = "https://auth.openai.com/oauth/token";
const DEFAULT_CLIENT_ID     = "codex-claude-bridge";
```

The Codex API endpoint in `scripts/codex/transport.ts` (Chat Completions
shape, model `gpt-5.4-codex`) is similarly provisional. Until these are
replaced with values lifted from the OpenAI reference plugin, no real
authentication or completion call can succeed.

### Task 1.1 — Inspect the reference plugin

Use the Codex CLI (`codex`) to fetch and review the OpenAI-published reference
plugin from GitHub:

```bash
# In a scratch dir
git clone https://github.com/openai/codex-claude-code-plugin reference-plugin
codex review reference-plugin --focus "OAuth authorize URL, token URL, \
client_id, scope strings, Codex completion endpoint, model name"
```

If that repo path is wrong, the reference plugin is whatever OpenAI ships
under `/plugin marketplace add` for their official Codex plugin — search
GitHub for `codex-claude-code` or `codex-plugin` under the `openai` org.

Extract the following values:

| Field | Source | Target |
|---|---|---|
| Authorize URL | reference `oauth.authorize_url` or equivalent | `DEFAULT_AUTHORIZE_URL` |
| Token URL | reference `oauth.token_url` | `DEFAULT_TOKEN_URL` |
| Client ID | reference `oauth.client_id` (provisioned to OpenAI) | `DEFAULT_CLIENT_ID` |
| Scopes | reference `oauth.scope` | `oauth_scope` in `schemas/config.json` + `DEFAULT_CONFIG` in `scripts/util/config.ts` |
| Completion endpoint | reference's POST URL | `CODEX_COMPLETION_URL` in `scripts/codex/transport.ts` |
| Model name | reference's payload `model:` field | `DEFAULT_MODEL` in `scripts/codex/transport.ts` |

### Task 1.2 — Patch the constants

Edit `scripts/auth/oauthClient.ts:11-15` JSDoc to remove the "Provisional
values" caveat, then update lines 32-34 with the real strings.

Edit `scripts/codex/transport.ts` similarly: replace the provisional URL and
model defaults.

### Task 1.3 — Verify

```bash
npm run verify          # All 152 tests should still pass
codex --version         # Confirm the codex CLI is installed
# Then manually:
# 1. Trigger /codex:setup against a real ChatGPT account
# 2. Confirm browser opens to the real OpenAI consent screen
# 3. Confirm callback returns 200 and token is cached
# 4. Confirm /codex:diff-review on a small diff produces a valid envelope
```

If the probe call fails with `401 invalid_token`, the scopes are wrong. If
it fails with `404`, the completion endpoint URL is wrong. If the browser
shows an OpenAI error page before consenting, the authorize URL or client_id
is wrong.

**Commit gate:** Do not commit hardcoded secrets. The client_id is public
(it is meant to identify the plugin to OAuth), but never commit a
provisioned client_secret if one exists — secrets belong in `auth.json` or
the OS keychain, both gitignored.

---

## §2 — BLOCKER: Slash commands lack an executable runner

**Symptom:** every `commands/*.md` frontmatter has `script:
${CLAUDE_PLUGIN_ROOT}/scripts/.../X.ts` and the body instructs Claude to
"invoke the auth subsystem … via its `authorize()` entry point." There is no
compiled `dist/`, no `tsx` / `ts-node` declared as a runtime dependency, and
no CLI wrappers (`async function main()` with arg parsing and exit codes).
The modules are libraries, not executables.

Until this is fixed, the slash commands cannot actually execute. (The five
agentic skills work fine — they activate by SKILL.md description match and
Claude orchestrates the helpers conversationally. The slash commands are
what need runtime wiring.)

Pick **one** of the three options below and apply it across all five command
files:

### Option A — Build pipeline + node runner (recommended for marketplace)

1. Add `bin` entries to `package.json` so each command has a node-executable
   entry point:
   ```json
   "bin": {
     "codex-bridge-auth":                     "dist/auth/cli.js",
     "codex-bridge-review":                   "dist/codex/cli-review.js",
     "codex-bridge-diff-review":              "dist/codex/cli-diff-review.js",
     "codex-bridge-rescue":                   "dist/codex/cli-rescue.js",
     "codex-bridge-status":                   "dist/concurrency/cli-status.js",
     "codex-bridge-adversarial-review":       "dist/codex/cli-adversarial-review.js",
     "codex-bridge-adversarial-diff-review":  "dist/codex/cli-adversarial-diff-review.js"
   }
   ```
2. Create thin CLI wrappers in `scripts/{auth,codex,concurrency}/cli-*.ts`
   that import their library counterparts, parse argv via `commander`
   (already in deps), call the lib, and exit with status. Each wrapper
   ≤ 50 LOC.
3. Add a `prepare` script to `package.json`:
   `"prepare": "npm run build"` so `npm install` produces `dist/`.
4. Update each `commands/*.md` frontmatter `script:` field to point at the
   compiled `dist/...cli-X.js`, or use a `bash:` directive to call the bin.
5. `npm run verify` and re-run a manual `/codex:status` to confirm.

### Option B — tsx as runtime dependency

1. `npm install --save tsx`.
2. Add CLI wrappers as in Option A, but skip the build step.
3. Each `commands/*.md` invokes `npx tsx scripts/.../cli-X.ts` via a
   shell-out in the command body.
4. Slower per-invocation than Option A but no build artifacts to ship.

### Option C — Demote slash commands to skills

If you decide the slash-command surface isn't worth the runner complexity,
delete `commands/*.md` and ship only the five agentic skills. The user
invokes everything by natural language ("review my diff against the seven
attack surfaces" → adversarial-plan-review picks up). This is the smallest
change but loses the parity-with-reference-plugin muscle memory.

> **Recommendation:** Option A. Marketplace plugins are typically shipped
> with `dist/` checked in or built on install; this is the most conventional
> path and the binaries become self-contained.

After fixing, run a manual end-to-end:
```bash
/codex:setup                          # OAuth flow completes
/codex:status                         # Shows empty job queue
/codex:adversarial-diff-review HEAD~1..HEAD --background
/codex:status                         # Shows the running job
```

---

## §3 — BLOCKER: Background mode does not actually detach

`scripts/concurrency/jobManager.ts` accepts `mode: "background"` and records
the job in the registry, but background mode currently just **does not
await** the promise. When the Node process exits at the end of the
slash-command turn, in-flight background work dies with it.

Per ROADMAP Phase 4, real background execution must:

1. **Spawn a detached subprocess.** On POSIX use
   `child_process.spawn(cmd, args, { detached: true, stdio: "ignore" })`
   then `.unref()`. On Windows use
   `spawn(cmd, args, { detached: true, windowsHide: true, stdio: "ignore" })`
   plus the `DETACHED_PROCESS` creation flag.
2. **Persist job state to disk** before the parent returns: PID, command
   line, start time, expected output path. Already partly done by
   `jobManager.ts` writing to
   `${CLAUDE_PLUGIN_DATA}/codex-bridge/jobs/<workspace-hash>/<registry>.json`
   — verify the write happens before the spawn returns and survives the
   parent's exit.
3. **Auto-deliver completion.** When the detached child finishes, it needs
   to publish its result somewhere Claude can re-read in a later turn.
   Recommended: write the result envelope to
   `${CLAUDE_PLUGIN_DATA}/codex-bridge/results/<job-id>.json`. The next time
   `/codex:status` runs, it scans that directory and surfaces completed
   results to the user.

### Tasks for §3

1. Implement `spawnDetached(jobId, cmd, args)` in
   `scripts/concurrency/jobManager.ts`. Test that the parent process can
   exit (`process.exit(0)`) before the child finishes and the child still
   completes.
2. Add a result-writer at the end of `adversarialEngine.ts` and
   `delegator.ts` that writes the final envelope to
   `${CLAUDE_PLUGIN_DATA}/codex-bridge/results/<job-id>.json`.
3. Extend `/codex:status` to surface unread results and mark them as read
   after display.
4. Add a unit test that simulates parent-exit-before-child-finishes (use
   `child_process.fork` of a 5-line stub script).

---

## §4 — Identity & TBD replacements

The actual remote is **`github.com/goosefly99/codex-claude-bridge-claude-plugin`**
but the metadata still says `github.com/TBD/codex-claude-bridge` in several
places. Replace verbatim:

| File:Line | Field | Current | Replace with |
|---|---|---|---|
| `package.json:33` | `author` | `"TBD"` | real author string |
| `package.json:35` | `homepage` | `https://github.com/TBD/codex-claude-bridge` | `https://github.com/goosefly99/codex-claude-bridge-claude-plugin` |
| `package.json:38` | `repository.url` | same TBD URL `.git` | real URL `.git` |
| `package.json:41` | `bugs.url` | same TBD URL `/issues` | real URL `/issues` |
| `marketplace.json:29-31` | `author.{name,email,url}` | all `"TBD"` | real values |
| `marketplace.json:34` | `homepage` | TBD | real URL |
| `marketplace.json:35` | `repository` | TBD `.git` | real `.git` |
| `marketplace.json:36` | `issues` | TBD `/issues` | real `/issues` |
| `marketplace.json:37` | `documentation` | TBD `#readme` | real `#readme` |
| `marketplace.json:46` | `install.command` | `/plugin marketplace add https://github.com/TBD/...` | real URL |
| `README.md:32` | install line | TBD URL | real URL |
| `schemas/config.json:3` | `$id` | `https://github.com/TBD/...config.json` | real URL |
| `schemas/adversarial-output.json:3` | `$id` | same pattern | real URL |
| `schemas/delegator-output.json:3` | `$id` | same pattern | real URL |
| `schemas/plan-review-output.json:3` | `$id` | same pattern | real URL |

**One test depends on a schema `$id` literal:** update
`tests/plan-reviewer.test.ts:142` to match whatever you set
`schemas/plan-review-output.json:3` to. Run `npm run verify` after — anti-drift
and shape tests should still pass.

> The string "TBD" also appears in `skills/implement-with-codex/SKILL.md:30`
> in the phrase _"No 'TBD's. No 'consider …'."_ — **leave that alone**, it
> is the prompt guidance about Codex plans, not metadata.

---

## §5 — CI workflow (ROADMAP exit criterion)

The ROADMAP requires green CI on Linux + macOS + Windows. There is no
`.github/` directory yet. Create:

`.github/workflows/verify.yml`:
```yaml
name: verify
on:
  push:
    branches: [main, auto_dev]
  pull_request:
    branches: [main]
jobs:
  verify:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        node: [20]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run verify
```

If Option A (build pipeline) is chosen in §2, add `- run: npm run build`
between `npm ci` and `npm run verify`.

Confirm the workflow runs green on a fresh push before relying on the badge.

---

## §6 — Phase 5 deliverables (docs + integration tests + publish)

### Task 6.1 — `docs/use-case-patterns.md`

Document each delegation pattern (P1 / P3 / P4 / P5 / P7) with a
copy-paste-ready user workflow. Source material is already in
`skills/implement-with-codex/patterns.md`; the new doc reframes it for the
**user** ("when should I use this?") rather than for Claude.

Suggested skeleton:
```
# Use-Case Patterns

## P1 — Hand off a clear plan to Codex
When to use … Example prompt … Expected outcome … Common failure mode …

## P3 — Closed-loop: Codex implements, Codex audits its own work
…
[etc. for P4, P5, P7]

## Choosing between patterns
Decision flowchart …
```

### Task 6.2 — Integration tests

Two new test files, both **skip-by-default** when no cached Codex token is
found (so CI does not break for contributors without an OpenAI account):

`tests/p1-integration.test.ts`:
- Confirm `delegate("trivial plan")` produces a `DelegationResult` with
  `status: "completed"` against a tiny scratch repo. Use `vi.skipIf` keyed
  on `process.env["CODEX_INTEGRATION"] !== "1"`.

`tests/p4-integration.test.ts`:
- Confirm `delegateParallel([{agent:"claude", plan}, {agent:"codex", plan}])`
  produces two side-by-side worktrees and cleans them up on success.

### Task 6.3 — README polish (screencasts / GIFs)

Add ≥ 2 GIFs to `README.md`:
1. `/codex:setup` OAuth flow end-to-end.
2. `/codex:adversarial-diff-review` (or `/codex:adversarial-review` on a
   folder) producing a finding and Claude plan mode re-reading it.
Store under `docs/media/`. Use `peek` or `kap` to record. Compress with
`gifsicle -O3` so each is under 1 MB.

### Task 6.4 — Tag v0.1.0 & publish

After all of §1-§5 are merged, §6.1-§6.3 are merged, and CI is green:

```bash
git checkout main
git pull
npm run verify
git tag -a v0.1.0 -m "v0.1.0 — initial release"
git push origin v0.1.0
gh release create v0.1.0 \
  --title "v0.1.0 — initial release" \
  --notes-file CHANGELOG.md
# Then submit the marketplace listing via whatever Anthropic's process is
# at that time (check claude.com/code/marketplace docs).
```

---

## §7 — Git push workflow (per established session pattern)

For every patch above, the workflow is:

```bash
# 1. Stage explicit paths only — never `git add -A`
git add <files>

# 2. Commit with a HEREDOC body
git commit -m "$(cat <<'EOF'
<imperative subject under 70 chars>

<body explaining why, not what>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"

# 3. Push to feature branch
git push origin auto_dev

# 4. Fast-forward main once green
git checkout main
git merge --ff-only auto_dev
git push origin main
git checkout auto_dev
```

**Constraints (from project CLAUDE.md, must remain in effect):**

- Never run agents directly against `main` / `master`. All work on feature
  branches.
- Never commit secrets. `auth.json`, `*.token`, `tokens.enc` are
  gitignored — keep it that way.
- Never use `-i` flags (`git rebase -i`, `git add -i`).
- Never use `--no-verify` to skip hooks.

---

## §8 — Locked invariants — DO NOT TOUCH

These are enforced by anti-drift tests. Any contributor "polishing" them
will turn the build red and that's the point.

### 8.1 — Seven attack surfaces (verbatim in `prompts/adversarial-system.md`)
```
Authentication
Data loss
Rollbacks
Race conditions
Degraded dependencies
Version skew
Observability gaps
```
Enforced by `tests/anti-drift.test.ts`. Generating attack surfaces
dynamically defeats the whole point of the locked taxonomy.

### 8.2 — Six plan-review categories (verbatim in `prompts/plan-review-system.md`)
Enforced by the same anti-drift test. Mirrors the seven-attack-surface
pattern.

### 8.3 — Skill trigger phrases
Each `skills/*/SKILL.md` description contains canonical user phrases that
must appear verbatim. Enforced by:
- `tests/skill-trigger-shape.test.ts`
- `tests/browser-verify-trigger-shape.test.ts`

If you reword the description, you will break these tests. That is
intentional — fuzzy matching only works if the trigger phrases the user
actually says are present in the description.

### 8.4 — Dual-registry concurrency
- Slash commands: depth-1 FIFO (one slash command at a time).
- Delegator: N-wide cap (4 by default, configurable via
  `delegator_max_concurrent`).
This split exists so user-typed slash commands stay predictable while
agentic delegation can fan out.

### 8.5 — Auth surface
OAuth-via-ChatGPT only. **No API-key fallback in v1** (DI-2). If a user
asks for one, point them at this constraint and the rationale in
`scripts/auth/oauthClient.ts:7-9`.

### 8.6 — Managed-by marker convention
`failure-as-knowledge` and `agents-md-sync` cooperate on the same AGENTS.md
sections via the `<!-- managed-by: X -->` HTML comment marker. The syncer
preserves these sections verbatim; the failure-logger only appends inside
its own marker. Do not refactor either skill in a way that ignores the
marker — they share a file and the marker is the contract.

---

## §9 — Definition of done

You are done with the v0.1.0 release when **all** of the following hold:

- [ ] §1 done: real OAuth and Codex endpoints in place; `/codex:setup`
      completes end-to-end against a real ChatGPT account.
- [ ] §2 done: all five slash commands execute their scripts at runtime;
      `/codex:status` and one other return correct output.
- [ ] §3 done: a `/codex:adversarial-diff-review HEAD~1..HEAD --background` job
      survives the parent session exiting and its result is surfaced by a
      later `/codex:status`.
- [ ] §4 done: no "TBD" strings in tracked metadata. `grep -r TBD` only
      matches `skills/implement-with-codex/SKILL.md:30` (the prompt
      guidance) and this handoff.
- [ ] §5 done: CI green on `ubuntu-latest`, `macos-latest`, and
      `windows-latest`.
- [ ] §6 done: `docs/use-case-patterns.md` published; two integration tests
      added (skip-by-default); two README GIFs in `docs/media/`.
- [ ] §6.4 done: `v0.1.0` tag pushed; GitHub release published; marketplace
      listing submitted.

Once those check, delete this handoff (or move it to `docs/archive/`) and
write a short `CHANGELOG.md` entry for v0.1.0.

— end of handoff —
