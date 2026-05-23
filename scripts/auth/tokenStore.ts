/**
 * Encrypted at-rest token cache.
 *
 * Storage strategy (in priority order):
 *   1. OS keychain via `keytar` — Keychain on macOS, Credential Manager on
 *      Windows, libsecret/Secret Service on Linux. Preferred when available.
 *   2. Filesystem fallback at `${CLAUDE_PLUGIN_DATA}/codex-bridge/auth.json`
 *      encrypted with libsodium (`sodium-native`) using a per-machine key
 *      derived from a stable machine-id source. File mode 0600 on Unix;
 *      ACL-restricted to the current user on Windows.
 *
 * Design constraints:
 *   - Tokens NEVER appear in logs. The redactor in scripts/util/log.ts will
 *     scrub them, but we also never log token values from this module.
 *   - Reads are sync-able (used in cold-path setup probe) but the public API
 *     is async to match keytar.
 *
 * @module scripts/auth/tokenStore
 */

import type { OAuthToken } from "./oauthClient.js";

/** The keytar service name we store the token under. */
export const SERVICE_NAME = "codex-claude-bridge";
/** The keytar account name (a single token per machine for v1). */
export const ACCOUNT_NAME = "default";

/**
 * Persist a token to the cache. Overwrites any existing token.
 *
 * @param token The OAuthToken to persist.
 * @returns void on success.
 * @throws ErrorKind.path_resolution if the data directory cannot be created.
 * @throws ErrorKind.auth_failed if encryption keys cannot be derived.
 */
export async function save(_token: OAuthToken): Promise<void> {
  throw new Error("not implemented");
}

/**
 * Load the cached token. Returns null if no token has been persisted (the
 * caller should treat null as "user must run /codex:setup").
 *
 * @returns The cached OAuthToken or null.
 * @throws ErrorKind.path_resolution on filesystem-fallback decrypt failures.
 */
export async function load(): Promise<OAuthToken | null> {
  throw new Error("not implemented");
}

/**
 * Clear the cached token. Idempotent; succeeds even if no token is cached.
 *
 * @returns void
 */
export async function clear(): Promise<void> {
  throw new Error("not implemented");
}
