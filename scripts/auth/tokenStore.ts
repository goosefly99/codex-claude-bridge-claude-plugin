/**
 * Token store — no-op shim for API-key auth.
 *
 * With OPENAI_API_KEY-based auth the bearer is read from the environment on
 * every call; there is nothing to persist. These stubs keep the module
 * interface intact so callers need no changes.
 *
 * @module scripts/auth/tokenStore
 */

import type { OAuthToken } from "./oauthClient.js";

export const SERVICE_NAME = "codex-claude-bridge";
export const ACCOUNT_NAME = "default";

/** No-op: API key is in the environment; nothing to save. */
export async function save(_token: OAuthToken): Promise<void> {}

/**
 * Returns null always. oauthClient.getToken() reads from OPENAI_API_KEY,
 * not from this store.
 */
export async function load(): Promise<OAuthToken | null> {
  return null;
}

/** No-op: nothing is stored. */
export async function clear(): Promise<void> {}
