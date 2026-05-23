/**
 * API-key auth shim for codex-claude-bridge.
 *
 * The original design used browser-based OAuth tied to a ChatGPT account.
 * This implementation replaces that with OPENAI_API_KEY from the environment,
 * matching how the installed `codex` CLI handles auth. The exported surface
 * (OAuthToken, authorize, refresh, getToken, revoke) is preserved so callers
 * need no changes.
 *
 * Setup: set OPENAI_API_KEY in your environment (or via `codex login`).
 * The `codex` binary and this plugin will both pick it up automatically.
 *
 * @module scripts/auth/oauthClient
 */

import { fetch } from "undici";

import { getLogger } from "../util/log.js";
import { getConfig } from "../util/config.js";

const log = getLogger("oauth");

/**
 * Token shape kept for interface compatibility. When using API-key auth,
 * `access_token` is the API key value and `expires_at` is set far in the
 * future (API keys don't expire on their own).
 */
export interface OAuthToken {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_at: number;
  scope?: string;
  account_email?: string;
}

/** Retained for interface compatibility. Not used with API-key auth. */
export interface OAuthOptions {
  authorize_url?: string;
  token_url?: string;
  client_id?: string;
  callback_port_range?: [number, number];
  logger?: unknown;
}

function requireApiKey(): string {
  const key = process.env["OPENAI_API_KEY"];
  if (!key?.trim()) {
    const err = new Error(
      "OPENAI_API_KEY is not set. Export it in your shell or set it in your environment before running /codex:setup.",
    );
    (err as Error & { cause?: unknown }).cause = { kind: "auth_failed" };
    throw err;
  }
  return key.trim();
}

function syntheticToken(apiKey: string): OAuthToken {
  return {
    access_token: apiKey,
    refresh_token: "",
    token_type: "Bearer",
    expires_at: Date.now() + 365 * 24 * 60 * 60 * 1000, // 1 year — API keys don't expire
  };
}

/**
 * "Authorize": validate that OPENAI_API_KEY is set and that a probe call
 * to the API succeeds. No browser flow.
 */
export async function authorize(_opts?: OAuthOptions): Promise<OAuthToken> {
  const apiKey = requireApiKey();
  const cfg = await getConfig();
  const url = `${cfg.api_base.replace(/\/+$/, "")}/chat/completions`;
  log.info("API-key auth: probing endpoint");
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) {
      const err = new Error("OPENAI_API_KEY is invalid or has insufficient permissions.");
      (err as Error & { cause?: unknown }).cause = { kind: "auth_failed" };
      throw err;
    }
  } catch (err) {
    if (err instanceof Error && (err as Error & { cause?: unknown }).cause) throw err;
    const wrapped = new Error(
      `API key probe failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    (wrapped as Error & { cause?: unknown }).cause = { kind: "auth_failed", original: String(err) };
    throw wrapped;
  }
  log.info("API-key auth verified");
  return syntheticToken(apiKey);
}

/**
 * Refresh: API keys don't expire, so this is a no-op that returns the same
 * synthetic token.
 */
export async function refresh(
  _token: OAuthToken,
  _opts?: OAuthOptions,
): Promise<OAuthToken> {
  return syntheticToken(requireApiKey());
}

/**
 * Return the raw API key as the bearer string. Called by transport.ts before
 * every request.
 */
export async function getToken(): Promise<string> {
  return requireApiKey();
}

/**
 * Revoke: API keys are managed in the OpenAI dashboard, not by this plugin.
 * This is a no-op.
 */
export async function revoke(): Promise<void> {
  log.info("revoke() is a no-op with API-key auth; remove the key via the OpenAI dashboard.");
}
