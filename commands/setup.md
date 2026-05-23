---
name: codex:setup
description: Authenticate with your existing ChatGPT account via browser-based OAuth and cache the token locally. Run this once per machine, or again whenever the cached token expires.
argument_hint: (no arguments)
allowed_tools: ["Bash", "Read"]
script: ${CLAUDE_PLUGIN_ROOT}/scripts/auth/oauthClient.ts
---

# /codex:setup

You are running the `codex-claude-bridge` setup command. Your job is to walk the user through a one-time browser-based OAuth flow against their ChatGPT account and verify that the cached token works against the Codex transport.

## Steps

1. Invoke the auth subsystem at `${CLAUDE_PLUGIN_ROOT}/scripts/auth/oauthClient.ts` via its `authorize()` entry point. Stream stdout to the user verbatim.
2. The auth client will:
   - Generate a PKCE code verifier and challenge.
   - Open the system default browser to the ChatGPT OAuth authorization URL.
   - Spin up a localhost callback listener on a high ephemeral port.
   - Receive the auth code and exchange it for an access + refresh token.
   - Persist both via `${CLAUDE_PLUGIN_ROOT}/scripts/auth/tokenStore.ts.save()` (OS keychain preferred, encrypted file fallback).
3. Run a probe call via `${CLAUDE_PLUGIN_ROOT}/scripts/codex/transport.ts` (cheap endpoint, e.g. `models.list`) to confirm the token is valid.
4. Print one of the following exit summaries:
   - On success: `OK — authenticated as <account-email>; token cached. Try /codex:review.`
   - On probe failure with otherwise-valid OAuth: `WARNING — OAuth completed but the probe call failed. Re-run /codex:setup or check network access to the Codex endpoint.`
   - On OAuth failure: explain the error class (browser, callback, exchange, refresh) and recommend the fix.

## Constraints

- **Never log the token.** All logging must go through `${CLAUDE_PLUGIN_ROOT}/scripts/util/log.ts` which redacts the `Authorization` header and any field matching `/token|secret|bearer|api[_-]?key/i`.
- **No API-key fallback.** This is OAuth-only in v1. If the user asks for API-key auth, point them at the v2 roadmap.
- **Idempotent.** Re-running `/codex:setup` while a valid token is cached must reuse it (or refresh silently); only re-prompt the browser if refresh fails.
- **Exit codes:** 0 on success, 2 on auth failure, 4 on network failure.
