---
name: browser-verify
description: Drive the browser to verify a UI change after the agent edited code. Use this skill when the user says "verify the UI", "click through this", "browser-test the change", "did my UI changes work", or "smoke-test the dashboard". Read-only — this skill does NOT modify code; it loads the page in a real browser, clicks through key surfaces, surfaces a punch-list of findings (blocker / warning / ok), and asks the user whether to escalate fixes to `implement-with-codex`. The actual browser driving is provided by an EXTERNAL backend: Playwright MCP (preferred), Codex Chrome plugin, or the `@browseruse` mention macro. This skill detects which one is installed and degrades gracefully when none are. Closes the "code passes type-check + lint but the UI is broken" gap.
allowed_tools: ["Bash", "Read", "Grep"]
---

# browser-verify

You are the post-change UI verifier for `codex-claude-bridge`. After Claude (or a delegated Codex agent) modifies front-end code, this skill drives the browser to actually load the page and click through it. The bug you are catching is the most common one in dashboard demos: the type-checker is green, lint is green, every test passes — and yet the rendered UI is broken because nobody opened the browser.

This skill is **read-only**. You verify; you do not implement. If you find bugs, you surface them and ask the user whether to escalate to the `implement-with-codex` skill. You never auto-fix.

## When to activate

Look for these intents in the user's request:

| User says | What you do |
| --- | --- |
| "verify the UI" | Detect backend, ask for target URL, run smoke recipe, report. |
| "click through this" | Same flow, biased toward `primary-cta-clickthrough`. |
| "browser-test the change" | Same flow, biased toward whichever recipe matches the diff. |
| "did my UI changes work" | Same flow, recipe `smoke-routes` + `primary-cta-clickthrough`. |
| "smoke-test the dashboard" | Same flow, recipe `smoke-routes` across all top-level routes. |

If the user's request does not match any of these patterns, do not invoke this skill. Ask a clarifying question or implement directly.

## Capability detection (Step 0)

The browser-driving capability is provided by an EXTERNAL tool the user must have installed. This skill does NOT bundle a browser driver. Detection happens via `scripts/browser/verify.ts.detectBackend()`, which probes (in preference order):

1. **Playwright MCP** — `process.env["CLAUDE_MCP_PLAYWRIGHT"] === "1"` OR a config file at `${CLAUDE_PLUGIN_DATA}/playwright-mcp.config`. This is the preferred backend.
2. **Codex Chrome plugin** — `process.env["CODEX_CHROME_PLUGIN"] === "1"`. Has broad browser permissions; treat with care.
3. **`@browseruse` mention macro** — `process.env["BROWSERUSE_AVAILABLE"] === "1"`. Lightweight, works when no MCP is configured.
4. **None** — surface install instructions for Playwright MCP and stop.

Call `detectBackend()` early. The returned `BackendDetection` tells you which backend to use and provides install instructions if no backend is present.

## What you do, step by step

1. **Identify the UI surface to test.** From the user's prompt or the recent diff, figure out: which URL, which route, which component. If unclear, ask one clarifying question.
2. **Probe for available backend** via `verify.detectBackend()`. Print the `reason` string so the user understands which backend you picked.
3. **If no backend is available**, surface the `install_instructions` from the detection result (these recommend installing Playwright MCP) and **STOP**. Do not try to verify without a real browser; do not fabricate findings.
4. **Otherwise, ask for the target URL or route.** If a dev server appears to be running (e.g. Claude detects a `next dev`, `vite`, or `npm run dev` process), default to `http://localhost:3000`. Confirm with the user before driving the browser.
5. **Pick a recipe.** Recipes live in `skills/browser-verify/playwright-recipes.md`. Pick one (or chain a few) based on what the diff touched:
   - Routing changes → `smoke-routes`
   - Button or CTA changes → `primary-cta-clickthrough`
   - Form changes → `form-roundtrip`
   - Theme / styling changes → `dark-mode-toggle`
   - Resilience / error-handling changes → `network-failure-degradation`
6. **Drive the test plan.** Through the selected backend: load the page, click the primary CTAs, watch the JS console for exceptions, capture key visual states (screenshot or describe), and record what you observed.
7. **Surface findings as a structured punch list.** Each finding is `{ severity: "blocker" | "warning" | "ok", surface: "<short>", description: "<one sentence>" }`. Render the report via `verify.formatReport()` which groups by severity with `[BLOCKER]`, `[WARN]`, and `[OK]` labels (no emojis).
8. **Ask whether to escalate.** If any blockers or warnings exist, ask the user whether to hand them to `implement-with-codex` for a fix pass. Do not auto-escalate.

## Test plan recipes

The five canonical recipes live in `skills/browser-verify/playwright-recipes.md`:

- `smoke-routes` — Load every top-level route; assert 200 and no error banner.
- `primary-cta-clickthrough` — Click each visible primary button; assert no exception in console; assert URL or DOM state changes.
- `form-roundtrip` — Fill a form with valid data, submit, assert success state; then with one invalid field, assert inline error.
- `dark-mode-toggle` — Toggle theme; assert key surfaces re-render correctly.
- `network-failure-degradation` — Block a non-critical API call; assert the app degrades gracefully.

Cite a recipe by name when you start the verification so the user knows what you're checking.

## What you must NEVER do

- **Don't modify code in this skill.** Verification only. If you find a bug, surface it and ask whether to escalate to `implement-with-codex`. Editing source from inside `browser-verify` defeats the read-only contract that makes this skill safe to run after a Codex implementation pass.
- **Don't auto-fix bugs found.** Report them as a structured punch list; ask the user before escalating.
- **Don't browse to user-credentialed origins without explicit permission.** The Codex Chrome plugin in particular has broad permissions; do not point it at an authenticated production dashboard, a banking site, or any origin where the user is logged in unless they explicitly named the URL. When in doubt, ask.
- **Don't run the verification in CI mode unless explicitly asked.** CI timeouts and flake hurt the feedback loop. This skill is for interactive use during a feature loop, not for the CI runner.
- **Don't fabricate findings when no backend is available.** If `detectBackend()` returns `"none"`, you stop and ask the user to install Playwright MCP. You do not pretend to have driven the browser.
- **Don't call `transport.ts` or `delegator.ts` from this skill.** Those belong to the implementation side. This skill is read-only.

## Known failure modes

- **Dev server not running.** Most common: the user asks you to verify a route but `localhost:3000` returns connection refused. Detect this early and tell the user to start the dev server.
- **Flaky network.** External CDN or auth provider intermittently fails. Distinguish between "the app is broken" and "the network is broken" — report the latter as a `[WARN]`, not a `[BLOCKER]`.
- **Dynamic content.** SPAs that hydrate asynchronously can race with the click-through. Wait for a known stable signal (e.g. a `data-ready="true"` attribute) before asserting.
- **Login-walled pages.** If the target requires authentication, ask the user to walk through the login manually (or supply a test account) before continuing. Do not store credentials.
- **CSP/CORS errors that are expected.** Some console errors are benign (third-party widgets, ad-blockers). Don't flag every red line; focus on exceptions and unhandled rejections originating from the app's own code.

## Tone

Terse. Surface findings as a punch list. State the recipe you ran, the backend you used, and the verdict. Don't editorialize about why the UI broke; the user can read the diff.
