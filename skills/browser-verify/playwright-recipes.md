# Browser-Verify Test Plan Recipes

Canonical recipes the `browser-verify` skill cites by name. Each recipe is a ready-to-paste markdown block: trigger ("when to use this recipe"), steps, assertions, and known pitfalls.

These recipes are written in Playwright-style language, but they are backend-agnostic — the same plan can be driven through the Codex Chrome plugin or the `@browseruse` macro. The point is the *test plan*, not the specific selectors.

---

## smoke-routes

**Trigger:** Routing changes, new pages added, router-config edits, or any "did I break navigation" question. Also the default first pass when the user says "smoke-test the dashboard".

**Steps:**
1. Enumerate the top-level routes (read the route config or sitemap; if unavailable, ask the user).
2. For each route, navigate to it with a 10-second timeout.
3. Wait for `networkidle` or a known ready signal before asserting.
4. Capture a screenshot or describe the rendered state in one sentence.
5. Move to the next route.

**Assertions:**
1. HTTP response status is 2xx (or 304 on cached navigations).
2. No 5xx error banner visible in the rendered DOM (`text=Internal Server Error`, `text=500`, etc.).
3. No uncaught JS exception logged in the browser console during navigation.
4. The page has a non-empty `<main>` or root container — empty body indicates hydration failure.

**Known pitfalls:**
- Client-side routers may render a soft 200 for a missing page. Cross-check with the route config rather than trusting the network response alone.
- A flash of unstyled content during navigation can look like a broken page in a screenshot. Wait for a stable ready signal.
- Auth-walled routes will redirect to login; record them separately and ask the user how to handle them.

---

## primary-cta-clickthrough

**Trigger:** Button changes, new CTAs added, onClick handler refactors, or any "does the button still work" question.

**Steps:**
1. Load the page under test.
2. Find every visible element matching `button[type="submit"]`, `[data-testid*="cta"]`, or the user-specified selector.
3. For each CTA, snapshot the URL and DOM hash.
4. Click the CTA with a 5-second post-click wait.
5. Snapshot the URL and DOM hash again.
6. Repeat for every primary CTA.

**Assertions:**
1. The click does not throw an exception in the browser console.
2. Either the URL changes, or the DOM hash changes, or a new visible element appears — i.e. *something* happened.
3. No accessibility regression: focus moves to a sensible target after click (modal, next page, success message).
4. No "double-fire" on the click handler (idempotency for non-destructive actions).

**Known pitfalls:**
- Disabled buttons may still emit `pointerdown` events; check `aria-disabled` and `disabled` attributes before clicking.
- Buttons that open external popups (OAuth flows) need an explicit allowlist — don't click into a payment provider during a smoke test.
- Some CTAs are async; without a wait, you'll snapshot before the state change lands.

---

## form-roundtrip

**Trigger:** Form changes, new validation rules, submission handler refactors, or any "does the form still submit" question.

**Steps:**
1. Load the page containing the form.
2. Fill every required field with valid data (use the user-provided fixture, or generate sensible defaults).
3. Submit the form.
4. Capture the post-submit state: URL, success banner, redirect, etc.
5. Reload, then fill the form with one deliberately invalid field (e.g. malformed email).
6. Submit again.
7. Capture the validation state: inline error, focus on the bad field, etc.

**Assertions:**
1. Valid submission yields a success indicator (URL change, banner, or DOM change confirming acceptance).
2. Valid submission does not throw a console exception.
3. Invalid submission shows an inline error attached to the bad field (not just a generic toast).
4. Invalid submission does NOT call the network endpoint — client-side validation should short-circuit.

**Known pitfalls:**
- Captchas and reCAPTCHA challenges will block the submission. Use a test-mode bypass if the app provides one, otherwise skip this recipe and tell the user.
- File-upload inputs need a real file path; the backend may not accept synthetic blobs.
- Forms that auto-save on blur can fire network requests before submit; account for them in the assertion.

---

## dark-mode-toggle

**Trigger:** Theme changes, CSS variable refactors, dark-mode bug reports, or any "does the toggle still work" question.

**Steps:**
1. Load the page in default theme.
2. Capture a screenshot or describe the current theme state.
3. Find the theme toggle (commonly `[aria-label*="theme"]`, `[data-testid="theme-toggle"]`, or the user-specified selector).
4. Click the toggle.
5. Wait 250ms for transitions to settle.
6. Capture again.
7. Toggle back and capture once more to verify reversibility.

**Assertions:**
1. The toggle changes a theme attribute or class on `<html>` or `<body>` (e.g. `data-theme="dark"`, `class="dark"`).
2. No flash of unstyled content during the transition.
3. Key text surfaces remain readable (contrast not catastrophically broken).
4. No text-over-image contrast bug — image overlays must still produce readable text in both themes.
5. The toggle is reversible: theme returns to the original state after two clicks.

**Known pitfalls:**
- `prefers-color-scheme` media-query overrides can clash with the explicit toggle. Test with the OS preference set in both directions.
- Server-side rendering can ship the wrong initial theme and flip on hydration. This is visible as a flash; record it as a `[WARN]`.
- Third-party widgets (chat bubbles, analytics overlays) may not respect the theme — flag but don't block.

---

## network-failure-degradation

**Trigger:** Resilience changes, new error-handling code, retry-logic refactors, or any "does the app survive when an API is down" question.

**Steps:**
1. Identify a non-critical API call (e.g. `/api/recommendations`, telemetry endpoint, third-party widget). If the user named one, use that.
2. Load the page once normally and confirm baseline behavior.
3. Configure the backend to block or 500 the chosen endpoint (Playwright: `page.route()`; browseruse: equivalent macro).
4. Reload the page.
5. Drive the same primary flow as the baseline.
6. Capture how the app behaves: graceful empty state, retry banner, silent failure, or crash.

**Assertions:**
1. The app does not crash to a blank screen or an unhandled error overlay.
2. Critical UI (header, navigation, primary CTAs) remains functional even when the blocked endpoint is dead.
3. The user sees a comprehensible signal that *something* is degraded (banner, skeleton, retry button) — not just a silent empty area.
4. No infinite retry loop hammers the dead endpoint at request rates > 1/sec.

**Known pitfalls:**
- Don't block the auth endpoint by accident — that'll knock the user out of the session and break every other recipe.
- Service workers can serve cached responses past the blocked endpoint; clear the SW cache if results look stale.
- Some apps treat ANY 5xx as a fatal crash; the recipe should expose that anti-pattern, not paper over it.

---

## Cross-recipe notes

- **Backend-agnostic.** These recipes are written so they translate one-to-one between Playwright MCP, the Codex Chrome plugin, and the `@browseruse` mention macro. The selector syntax may vary; the test plan does not.
- **Recipe chaining.** It's normal to chain two or three recipes in one verification pass (e.g. `smoke-routes` then `primary-cta-clickthrough` on the home route). State the chain order before driving.
- **Stop on blocker.** If a recipe surfaces a `[BLOCKER]` finding, stop the verification and surface the punch list. Don't keep clicking through a broken app.
- **Don't auto-fix.** If you found a bug, ask the user whether to escalate to `implement-with-codex`. This skill is read-only.
