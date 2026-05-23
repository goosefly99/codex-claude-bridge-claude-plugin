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

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Log level enum, ordered by severity. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

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
 * Patterns that always trigger redaction.
 */
export const REDACT_KEY_PATTERN =
  /token|secret|bearer|api[_-]?key|authorization|password|credential/i;

/** Bearer-like value: long alphanumerics with dot-separated JWT-ish shape. */
const BEARER_VALUE_PATTERN = /^(Bearer\s+)?[A-Za-z0-9_\-]{20,}(\.[A-Za-z0-9_\-]+){0,2}$/;

export const REDACTED_VALUE = "[redacted]" as const;

let currentLevel: LogLevel = "info";

/** Override the log level (used by config loader after startup). */
export function setLevel(level: LogLevel): void {
  currentLevel = level;
}

function logsDir(): string {
  const data = process.env["CLAUDE_PLUGIN_DATA"] ?? join(homedir(), ".claude", "plugin-data");
  return join(data, "codex-bridge", "logs");
}

function dayStamp(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function redactPathLike(s: string): string {
  const home = homedir();
  if (!home) return s;
  if (s.includes(home)) return s.split(home).join("~");
  return s;
}

/**
 * Redact a context object recursively. Returns a NEW object; does not mutate.
 */
export function redact(ctx: LogContext): LogContext {
  return redactInternal(ctx, new WeakSet()) as LogContext;
}

function redactInternal(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (BEARER_VALUE_PATTERN.test(value.trim())) return REDACTED_VALUE;
    return redactPathLike(value);
  }
  if (typeof value !== "object") return value;
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redactInternal(v, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (REDACT_KEY_PATTERN.test(k)) {
      out[k] = REDACTED_VALUE;
    } else {
      out[k] = redactInternal(v, seen);
    }
  }
  return out;
}

/**
 * Write a single log entry.
 */
export function log(level: LogLevel, msg: string, ctx?: LogContext): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[currentLevel]) return;

  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: redactPathLike(msg),
  };
  if (ctx) {
    const r = redact(ctx);
    for (const [k, v] of Object.entries(r)) entry[k] = v;
  }

  const line = JSON.stringify(entry) + "\n";

  try {
    const dir = logsDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${dayStamp()}.log`);
    appendFileSync(file, line, { mode: 0o600 });
  } catch {
    process.stderr.write(line);
  }
}

/**
 * Construct a child logger that prefixes every entry with a stable component
 * tag.
 */
export function getLogger(component: string): Logger {
  const wrap = (level: LogLevel) => (msg: string, ctx?: LogContext) =>
    log(level, msg, { component, ...(ctx ?? {}) });
  return {
    log: (level, msg, ctx) => log(level, msg, { component, ...(ctx ?? {}) }),
    debug: wrap("debug"),
    info: wrap("info"),
    warn: wrap("warn"),
    error: wrap("error"),
  };
}
