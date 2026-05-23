/**
 * Codex Chat Completions transport client.
 *
 * Single point of policy for:
 *   - HTTP request/response serialization
 *   - Authentication (bearer from auth/oauthClient.getToken)
 *   - Retry/backoff on 429 and 5xx (max 3 retries, exponential)
 *   - Streaming-vs-non-streaming responses
 *   - Error normalization into ErrorKind
 *   - Local JSONL logging via scripts/util/log.ts (redacted)
 *
 * Endpoint default: https://api.openai.com/v1/chat/completions with
 * model=gpt-5.4-codex.
 *
 * @module scripts/codex/transport
 */

import { fetch } from "undici";

import { getToken } from "../auth/oauthClient.js";
import { getConfig } from "../util/config.js";
import { getLogger } from "../util/log.js";

const log = getLogger("transport");

export type ErrorKind =
  | "auth_failed"
  | "rate_limited"
  | "network"
  | "upstream_5xx"
  | "malformed_response"
  | "git_state"
  | "path_resolution"
  | "no_git_repo";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
}

export interface CompletionOptions {
  model?: string;
  reasoning_effort?: "low" | "medium" | "high";
  stream?: boolean;
  api_base?: string;
  max_retries?: number;
  timeout_ms?: number;
  signal?: AbortSignal;
  response_format?: { type: "json_object" | "text" };
}

export interface CompletionResult {
  message: ChatMessage;
  finish_reason: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  request_id?: string;
}

function tagError(message: string, kind: ErrorKind, original?: unknown): Error {
  const err = new Error(message);
  (err as Error & { cause?: unknown }).cause = { kind, original };
  return err;
}

function backoffMs(attempt: number, retryAfterSec?: number): number {
  if (retryAfterSec && retryAfterSec > 0) return retryAfterSec * 1000;
  const base = 500;
  const jitter = Math.floor(Math.random() * 250);
  return base * Math.pow(2, attempt) + jitter;
}

interface ChatCompletionApiResponse {
  id?: string;
  choices?: Array<{
    message?: { role: ChatMessage["role"]; content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export async function sendCompletion(
  messages: ChatMessage[],
  opts?: CompletionOptions,
): Promise<CompletionResult> {
  const cfg = await getConfig();
  const apiBase = opts?.api_base ?? cfg.api_base;
  const model = opts?.model ?? cfg.model;
  const maxRetries = opts?.max_retries ?? cfg.max_retries;
  const timeoutMs = opts?.timeout_ms ?? cfg.timeout_ms;

  let bearer: string;
  try {
    bearer = await getToken();
  } catch (err) {
    throw tagError("auth failed before sending request", "auth_failed", err);
  }

  const url = `${apiBase.replace(/\/+$/, "")}/chat/completions`;

  const body: Record<string, unknown> = {
    model,
    messages,
  };
  if (opts?.reasoning_effort) body["reasoning_effort"] = opts.reasoning_effort;
  if (opts?.response_format) body["response_format"] = opts.response_format;
  if (opts?.stream) body["stream"] = true;

  let lastErr: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timeoutHandle = setTimeout(() => ctrl.abort(), timeoutMs);
    if (opts?.signal) {
      if (opts.signal.aborted) ctrl.abort();
      else opts.signal.addEventListener("abort", () => ctrl.abort());
    }

    try {
      log.debug("sending completion", { model, attempt, message_count: messages.length });
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timeoutHandle);

      const reqId = res.headers.get("x-request-id") ?? undefined;

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after") ?? "0");
        if (attempt < maxRetries) {
          const wait = backoffMs(attempt, isNaN(retryAfter) ? 0 : retryAfter);
          log.warn("429 rate-limited; backing off", { attempt, wait_ms: wait });
          await sleep(wait);
          continue;
        }
        throw tagError("rate limited after retries", "rate_limited");
      }

      if (res.status >= 500) {
        if (attempt < maxRetries) {
          const wait = backoffMs(attempt);
          log.warn("5xx upstream; backing off", { attempt, status: res.status, wait_ms: wait });
          await sleep(wait);
          continue;
        }
        throw tagError(`upstream returned ${res.status}`, "upstream_5xx");
      }

      if (res.status === 401 || res.status === 403) {
        throw tagError(`auth rejected with ${res.status}`, "auth_failed");
      }

      if (!res.ok) {
        const text = await res.text();
        throw tagError(
          `unexpected response ${res.status}: ${text.slice(0, 200)}`,
          "malformed_response",
        );
      }

      const data = (await res.json()) as ChatCompletionApiResponse;
      const choice = data.choices?.[0];
      if (!choice?.message?.content) {
        throw tagError("response missing choice/message/content", "malformed_response");
      }

      return {
        message: {
          role: choice.message.role,
          content: choice.message.content,
        },
        finish_reason: choice.finish_reason ?? "stop",
        ...(data.usage ? { usage: data.usage } : {}),
        ...(reqId ? { request_id: reqId } : {}),
      };
    } catch (err) {
      clearTimeout(timeoutHandle);
      lastErr = err instanceof Error ? err : new Error(String(err));
      const cause = (lastErr as Error & { cause?: { kind?: ErrorKind } }).cause;
      const kind = cause?.kind;
      if (kind === "auth_failed" || kind === "malformed_response") throw lastErr;
      if (attempt >= maxRetries) {
        if (kind) throw lastErr;
        throw tagError("network error after retries", "network", lastErr);
      }
      const wait = backoffMs(attempt);
      log.warn("transient error; backing off", { attempt, err: String(err), wait_ms: wait });
      await sleep(wait);
    }
  }

  throw lastErr ?? tagError("unknown transport failure", "network");
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
