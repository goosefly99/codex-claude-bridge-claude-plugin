/**
 * JSONL logger with redaction.
 *
 * Hard rules (DI-2 + privacy):
 *   - The OAuth bearer token never appears in any log file or stderr emission.
 *   - In non-debug mode, prompt bodies are summarized (truncated and hashed)
 *     not written verbatim, so a leaked log doesn't expose user code.
 *   - Absolute paths under the user's home directory are partially redacted to
 *     `~/...` before logging.
 *
 * Output format: line-delimited JSON to
 * `${CLAUDE_PLUGIN_DATA}/codex-bridge/logs/<YYYY-MM-DD>.log`. One log line
 * per event. Easy to grep, easy to ship to a vector store later, no PII.
 *
 * @module scripts/util/log
 */

/** Log level enum, ordered by severity. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Redacted, structured context attached to a log entry. */
export type LogContext = Record<string, unknown>;

/** Logger interface; implementations may write to file, stderr, or memory. */
export interface Logger {
  log(level: LogLevel, msg: string, ctx?: LogContext): void;
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
}

/**
 * Patterns that always trigger redaction. Matched against context keys
 * (case-insensitive). Values for matching keys are replaced with `[redacted]`.
 */
export const REDACT_KEY_PATTERN =
  /token|secret|bearer|api[_-]?key|authorization|password|credential/i;

/**
 * The Authorization header value (and other bearer-like strings) is replaced
 * with this constant before serialization.
 */
export const REDACTED_VALUE = "[redacted]" as const;

/**
 * Write a single log entry. Routes through the redactor before writing.
 *
 * Behavior:
 *   - Serializes `{ ts, level, msg, ...redactedCtx }` as a single JSON line.
 *   - Appends to the current day's log file.
 *   - On filesystem failures, falls back to stderr (also redacted).
 *
 * @param level Severity.
 * @param msg Human-readable message.
 * @param ctx Optional structured context. Keys matching REDACT_KEY_PATTERN
 *   have their values redacted.
 */
export function log(_level: LogLevel, _msg: string, _ctx?: LogContext): void {
  throw new Error("not implemented");
}

/**
 * Construct a child logger that prefixes every entry with a stable component
 * tag (e.g. "auth", "transport", "jobManager"). Useful for grepping.
 *
 * @param component Component tag, conventionally lowercase short.
 * @returns A Logger that writes to the same backing store.
 */
export function getLogger(_component: string): Logger {
  throw new Error("not implemented");
}

/**
 * Redact a context object in-place. Exposed for unit tests; production code
 * should use log() directly.
 *
 * @param ctx The context object to redact.
 * @returns A new redacted context (does not mutate input).
 */
export function redact(_ctx: LogContext): LogContext {
  throw new Error("not implemented");
}
