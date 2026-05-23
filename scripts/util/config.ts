/**
 * Plugin configuration loader.
 *
 * Default config ships at `<plugin-root>/config.json`. Per-machine overrides
 * live at `${CLAUDE_PLUGIN_DATA}/codex-bridge/config.json`. The override file
 * is shallow-merged onto the defaults; missing keys fall through to defaults.
 *
 * Config is validated against `schemas/config.json` on load. Validation
 * failures fail fast — better to refuse to run than silently use a bad value.
 *
 * @module scripts/util/config
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { setLevel, getLogger } from "./log.js";

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = resolve(dirname(__filename), "..", "..");

const log = getLogger("config");

/** The full plugin configuration shape. Mirrors schemas/config.json. */
export interface PluginConfig {
  model: string;
  api_base: string;
  diff_files_threshold: number;
  diff_loc_threshold: number;
  max_retries: number;
  timeout_ms: number;
  log_level: "debug" | "info" | "warn" | "error";
  context_token_budget: number;
  delegator_max_concurrent: number;
  delegator_isolate_worktrees: boolean;
  oauth_client_id?: string;
  oauth_authorize_url?: string;
  oauth_token_url?: string;
}

/** Default config values, used when no on-disk config is present. */
export const DEFAULT_CONFIG: PluginConfig = {
  model: "gpt-5.4-codex",
  api_base: "https://api.openai.com/v1",
  diff_files_threshold: 8,
  diff_loc_threshold: 500,
  max_retries: 3,
  timeout_ms: 300_000,
  log_level: "info",
  context_token_budget: 60_000,
  delegator_max_concurrent: 4,
  delegator_isolate_worktrees: false,
};

let cached: PluginConfig | null = null;

function overridePath(): string {
  const data = process.env["CLAUDE_PLUGIN_DATA"] ?? join(homedir(), ".claude", "plugin-data");
  return join(data, "codex-bridge", "config.json");
}

function readJsonIfPresent(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    log.warn("config file is unreadable, ignoring", { path, err: String(err) });
    return null;
  }
}

function validate(cfg: unknown): cfg is PluginConfig {
  const schemaPath = join(PLUGIN_ROOT, "schemas", "config.json");
  const schemaRaw = readFileSync(schemaPath, "utf-8");
  const schema = JSON.parse(schemaRaw) as object;
  const ajv = new (Ajv2020 as unknown as new (opts: object) => {
    compile(s: object): (data: unknown) => boolean;
  })({ allErrors: true, strict: false });
  (addFormats as unknown as (a: unknown) => void)(ajv);
  const validateFn = ajv.compile(schema);
  return validateFn(cfg);
}

/**
 * Load and validate the merged config. Cached after the first call.
 */
export async function getConfig(opts?: { refresh?: boolean }): Promise<PluginConfig> {
  if (cached && !opts?.refresh) return cached;

  const defaultsPath = join(PLUGIN_ROOT, "config.json");
  const defaultsRaw = readJsonIfPresent(defaultsPath) ?? {};
  const overrideRaw = readJsonIfPresent(overridePath()) ?? {};

  const merged = { ...DEFAULT_CONFIG, ...defaultsRaw, ...overrideRaw } as Record<string, unknown>;
  // Drop $schema if present so validation doesn't choke.
  delete merged["$schema"];

  if (!validate(merged)) {
    throw new Error("config validation failed (see schemas/config.json)");
  }

  cached = merged as unknown as PluginConfig;
  setLevel(cached.log_level);
  log.debug("config loaded", { keys: Object.keys(cached) });
  return cached;
}
