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

/** The full plugin configuration shape. Mirrors schemas/config.json. */
export interface PluginConfig {
  /** Codex model alias to use. Default: "gpt-5.4-codex". */
  model: string;
  /** Codex API base URL. Default: "https://api.openai.com/v1". */
  api_base: string;
  /** Files-changed threshold for sync-vs-bg classification. Default: 8. */
  diff_files_threshold: number;
  /** Total LOC delta threshold. Default: 500. */
  diff_loc_threshold: number;
  /** Max retries on 429/5xx in transport. Default: 3. */
  max_retries: number;
  /** Per-request timeout in milliseconds. Default: 300000 (5 minutes). */
  timeout_ms: number;
  /** Logger verbosity. Default: "info". "debug" includes prompt bodies. */
  log_level: "debug" | "info" | "warn" | "error";
  /** Token budget for context collection in adversarialEngine. Default: 60000. */
  context_token_budget: number;
  /** OAuth client_id (set during Phase 0 source-inspection). */
  oauth_client_id?: string;
  /** OAuth authorize URL override. */
  oauth_authorize_url?: string;
  /** OAuth token-exchange URL override. */
  oauth_token_url?: string;
}

/**
 * Load and validate the merged config. Cached after the first call; pass
 * `{ refresh: true }` to bypass the cache in tests.
 *
 * @param opts Loader options.
 * @returns The resolved PluginConfig.
 * @throws ErrorKind.path_resolution if config files are unreadable.
 * @throws Error if validation against schemas/config.json fails.
 */
export async function getConfig(_opts?: {
  refresh?: boolean;
}): Promise<PluginConfig> {
  throw new Error("not implemented");
}

/**
 * Default config values, used when no on-disk config is present. Exported for
 * testing and so init scripts can write the file.
 */
export const DEFAULT_CONFIG: PluginConfig = {
  model: "gpt-5.4-codex",
  api_base: "https://api.openai.com/v1",
  diff_files_threshold: 8,
  diff_loc_threshold: 500,
  max_retries: 3,
  timeout_ms: 300_000,
  log_level: "info",
  context_token_budget: 60_000,
};
