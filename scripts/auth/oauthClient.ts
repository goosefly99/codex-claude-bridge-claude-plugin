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

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { exec } from "node:child_process";

import { fetch } from "undici";

import { getConfig } from "../util/config.js";
import { getLogger, type Logger } from "../util/log.js";
import { load as loadToken, save as saveToken } from "./tokenStore.js";

const log = getLogger("oauth");

const DEFAULT_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const DEFAULT_TOKEN_URL = "https://auth.openai.com/oauth/token";
const DEFAULT_CLIENT_ID = "codex-claude-bridge";
const DEFAULT_PORT_RANGE: [number, number] = [49152, 65535];
const REFRESH_LEAD_RATIO = 0.1;

export interface OAuthToken {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_at: number;
  scope?: string;
  account_email?: string;
}

export interface OAuthOptions {
  authorize_url?: string;
  token_url?: string;
  client_id?: string;
  callback_port_range?: [number, number];
  logger?: Logger;
}

function pkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  if (platform === "win32") {
    cmd = `start "" "${url}"`;
  } else if (platform === "darwin") {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, (err) => {
    if (err) log.warn("could not launch browser; open the URL manually", { url });
  });
}

interface AuthCodeCapture {
  code: string;
  state: string;
}

function startCallbackServer(
  expectedState: string,
  portRange: [number, number],
): Promise<{ port: number; result: Promise<{ code: string; redirect_uri: string }> }> {
  return new Promise((resolveBound, rejectBound) => {
    const port =
      portRange[0] + Math.floor(Math.random() * (portRange[1] - portRange[0]));
    let resolveResult: (v: { code: string; redirect_uri: string }) => void;
    let rejectResult: (e: Error) => void;
    const result = new Promise<{ code: string; redirect_uri: string }>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const errParam = url.searchParams.get("error");

      if (errParam) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("OAuth error: " + errParam);
        server.close();
        rejectResult(new Error("OAuth authorization error: " + errParam));
        return;
      }
      if (!code || !state || state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad callback: missing or mismatched state.");
        server.close();
        rejectResult(new Error("OAuth callback missing or mismatched state"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<html><body><h3>Authenticated. You may close this tab.</h3></body></html>",
      );
      const capture: AuthCodeCapture = { code, state };
      server.close();
      resolveResult({
        code: capture.code,
        redirect_uri: `http://127.0.0.1:${port}/callback`,
      });
    });

    server.on("error", (err) => {
      rejectBound(err);
    });

    server.listen(port, "127.0.0.1", () => {
      resolveBound({ port, result });
    });
  });
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  account_email?: string;
}

async function exchange(
  tokenUrl: string,
  body: Record<string, string>,
): Promise<OAuthToken> {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`token endpoint returned ${res.status}: ${text}`);
    (err as Error & { cause?: unknown }).cause = { kind: "auth_failed" };
    throw err;
  }

  const data = (await res.json()) as TokenResponse;
  const expiresIn = data.expires_in ?? 3600;
  const expires_at = Date.now() + expiresIn * 1000;
  const token: OAuthToken = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: "Bearer",
    expires_at,
    ...(data.scope ? { scope: data.scope } : {}),
    ...(data.account_email ? { account_email: data.account_email } : {}),
  };
  return token;
}

export async function authorize(opts?: OAuthOptions): Promise<OAuthToken> {
  const cfg = await getConfig();
  const authorizeUrl = opts?.authorize_url ?? cfg.oauth_authorize_url ?? DEFAULT_AUTHORIZE_URL;
  const tokenUrl = opts?.token_url ?? cfg.oauth_token_url ?? DEFAULT_TOKEN_URL;
  const clientId = opts?.client_id ?? cfg.oauth_client_id ?? DEFAULT_CLIENT_ID;
  const portRange = opts?.callback_port_range ?? DEFAULT_PORT_RANGE;

  const verifier = pkceVerifier();
  const challenge = pkceChallenge(verifier);
  const state = randomBytes(16).toString("base64url");

  const { port, result: callbackPromise } = await startCallbackServer(state, portRange);
  const redirect_uri = `http://127.0.0.1:${port}/callback`;

  const authUrl = new URL(authorizeUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirect_uri);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("scope", "codex.invoke profile email");

  openBrowser(authUrl.toString());
  log.info("waiting for browser OAuth callback", { authorize_url: authorizeUrl });

  const callback = await Promise.race([
    callbackPromise,
    new Promise<never>((_, rej) =>
      setTimeout(
        () => rej(new Error("OAuth callback timed out after 5 minutes")),
        5 * 60_000,
      ),
    ),
  ]);

  const token = await exchange(tokenUrl, {
    grant_type: "authorization_code",
    code: callback.code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: callback.redirect_uri,
  });

  await saveToken(token);
  return token;
}

export async function refresh(token: OAuthToken, opts?: OAuthOptions): Promise<OAuthToken> {
  const cfg = await getConfig();
  const tokenUrl = opts?.token_url ?? cfg.oauth_token_url ?? DEFAULT_TOKEN_URL;
  const clientId = opts?.client_id ?? cfg.oauth_client_id ?? DEFAULT_CLIENT_ID;

  const refreshed = await exchange(tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: token.refresh_token,
    client_id: clientId,
  });
  await saveToken(refreshed);
  return refreshed;
}

export async function getToken(): Promise<string> {
  const cached = await loadToken();
  if (!cached) {
    const err = new Error("no cached token; run /codex:setup");
    (err as Error & { cause?: unknown }).cause = { kind: "auth_failed" };
    throw err;
  }

  const now = Date.now();
  const lead = Math.max(60_000, (cached.expires_at - now) * REFRESH_LEAD_RATIO);
  if (now + lead >= cached.expires_at) {
    try {
      const fresh = await refresh(cached);
      return fresh.access_token;
    } catch (err) {
      const wrapped = new Error("token refresh failed; re-run /codex:setup");
      (wrapped as Error & { cause?: unknown }).cause = { kind: "auth_failed", original: String(err) };
      throw wrapped;
    }
  }

  return cached.access_token;
}

export async function revoke(): Promise<void> {
  const { clear } = await import("./tokenStore.js");
  await clear();
}
