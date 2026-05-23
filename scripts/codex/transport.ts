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
 * model=gpt-5.4-codex (or whatever alias the OpenAI reference plugin uses;
 * Phase 0 source-inspection finalizes this).
 *
 * @module scripts/codex/transport
 */

/** Concrete error categories surfaced to callers. */
export type ErrorKind =
  | "auth_failed"
  | "rate_limited"
  | "network"
  | "upstream_5xx"
  | "malformed_response"
  | "git_state"
  | "path_resolution"
  | "no_git_repo";

/** A single Chat Completions message. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Optional tool-call name when role === "tool". */
  name?: string;
}

/** Options for a single completion request. */
export interface CompletionOptions {
  /** Model alias (defaults to config.json `model`). */
  model?: string;
  /** Reasoning effort hint forwarded to the API. */
  reasoning_effort?: "low" | "medium" | "high";
  /** If true, return a streaming response. */
  stream?: boolean;
  /** Override base URL (defaults to config.json `api_base`). */
  api_base?: string;
  /** Per-request retry budget; defaults to config `max_retries`. */
  max_retries?: number;
  /** Per-request timeout in ms; defaults to 5 minutes. */
  timeout_ms?: number;
  /** AbortSignal for cancellation (used by jobManager.cancel()). */
  signal?: AbortSignal;
  /** Optional response_format override (e.g. { type: "json_object" }). */
  response_format?: { type: "json_object" | "text" };
}

/** Successful completion result. */
export interface CompletionResult {
  /** The full message returned by the model. */
  message: ChatMessage;
  /** Provider-reported finish reason. */
  finish_reason: string;
  /** Usage breakdown (prompt + completion + total tokens). */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  /** Provider request ID for observability/debugging. */
  request_id?: string;
}

/**
 * POST a chat completion to the Codex endpoint.
 *
 * Behavior:
 *   - Loads bearer via getToken(); on token errors throws ErrorKind=auth_failed.
 *   - Applies exponential backoff on 429 (honors Retry-After) and 5xx.
 *   - Normalizes provider errors into the ErrorKind enum.
 *   - Logs requests through the redacted JSONL logger (no token, no full
 *     prompt body in non-debug mode).
 *
 * @param messages Ordered chat messages (system prompt first).
 * @param opts Request options.
 * @returns A CompletionResult with the model's reply.
 * @throws Error tagged with `cause: { kind: ErrorKind, ... }` on any failure.
 */
export async function sendCompletion(
  _messages: ChatMessage[],
  _opts?: CompletionOptions,
): Promise<CompletionResult> {
  throw new Error("not implemented");
}
