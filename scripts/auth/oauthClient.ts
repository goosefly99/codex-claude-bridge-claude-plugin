/**
 * ChatGPT OAuth client with PKCE.
 *
 * Implements the browser-based OAuth flow tied to a user's ChatGPT account.
 * All five slash commands depend on this subsystem for credentials.
 *
 * Design decision (DI-2): API-key fallback is NOT supported in v1. Auth is
 * OAuth-via-ChatGPT only, preserving the "free with your existing
 * subscription" value proposition.
 *
 * Endpoint targets (Phase 0 source-inspection of the OpenAI reference plugin
 * is required before locking these in). Provisional values:
 *   - Authorization: https://auth.openai.com/oauth/authorize
 *   - Token exchange: https://auth.openai.com/oauth/token
 *   - Token refresh: same endpoint with grant_type=refresh_token
 *
 * @module scripts/auth/oauthClient
 */

import type { Logger } from "../util/log.js";

/**
 * The token shape we cache locally. `access_token` is the bearer used by the
 * transport client. `refresh_token` lets us silently refresh before expiry.
 * `expires_at` is an absolute UNIX-epoch milliseconds; refresh kicks in at 90%
 * of the original TTL to avoid expiry races.
 */
export interface OAuthToken {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_at: number; // ms since epoch
  scope?: string;
  account_email?: string;
}

/**
 * Options for the OAuth client. Most users should accept the defaults.
 */
export interface OAuthOptions {
  /** Authorization URL (defaults to the canonical ChatGPT OAuth endpoint). */
  authorize_url?: string;
  /** Token-exchange URL. */
  token_url?: string;
  /** OAuth client_id; provisioned by the plugin author. */
  client_id?: string;
  /** Localhost callback port range; defaults to ephemeral high port. */
  callback_port_range?: [number, number];
  /** Logger for redacted progress messages. */
  logger?: Logger;
}

/**
 * Run the full browser-based OAuth flow with PKCE.
 *
 * Steps:
 *   1. Generate a PKCE code_verifier (43-128 chars) and SHA-256 challenge.
 *   2. Bind a localhost listener on a high ephemeral port.
 *   3. Open the system browser to the authorize_url with code_challenge,
 *      redirect_uri (the localhost callback), state, and scope.
 *   4. Receive the auth code on the localhost listener.
 *   5. POST to token_url with code + code_verifier; receive access + refresh
 *      tokens.
 *   6. Persist via tokenStore.save().
 *   7. Return the new token.
 *
 * @param opts Optional configuration.
 * @returns The newly-minted OAuthToken.
 * @throws ErrorKind.auth_failed on any step that prevents token issuance.
 */
export async function authorize(_opts?: OAuthOptions): Promise<OAuthToken> {
  throw new Error("not implemented");
}

/**
 * Silently refresh an existing token using its refresh_token.
 *
 * If refresh fails (e.g. the refresh token itself has expired), throws
 * ErrorKind.auth_failed with a hint to re-run /codex:setup. Callers should
 * surface that hint to the user rather than retrying.
 *
 * @param token The currently-cached token to refresh.
 * @param opts Optional configuration.
 * @returns A fresh OAuthToken with extended expires_at.
 */
export async function refresh(
  _token: OAuthToken,
  _opts?: OAuthOptions,
): Promise<OAuthToken> {
  throw new Error("not implemented");
}

/**
 * Convenience: load the cached token, refreshing if it's within 10% of
 * expiry, and return the bearer string for use in Authorization headers.
 *
 * This is the primary entry point used by transport.ts. Other callers should
 * prefer this over directly reading from tokenStore.
 *
 * @returns The bearer token string (without the "Bearer " prefix).
 * @throws ErrorKind.auth_failed if no token is cached or refresh fails.
 */
export async function getToken(): Promise<string> {
  throw new Error("not implemented");
}

/**
 * Revoke the cached token (best-effort upstream) and clear local cache.
 *
 * Used by `/codex:setup --reset` (when implemented) or by support scripts
 * during testing. v1 does not expose a user-facing revoke command.
 *
 * @returns void
 */
export async function revoke(): Promise<void> {
  throw new Error("not implemented");
}
