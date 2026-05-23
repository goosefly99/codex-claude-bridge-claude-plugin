#!/usr/bin/env node
/**
 * CLI entry point for /codex:setup.
 * Validates that OPENAI_API_KEY is set and the endpoint is reachable.
 * Idempotent — safe to re-run. Exit 0 on success, 2 on auth failure, 4 on network.
 */
import { program } from "commander";

import { authorize } from "./oauthClient.js";
import { getLogger } from "../util/log.js";

const log = getLogger("cli-setup");

program.name("codex-bridge-auth").description("Validate OPENAI_API_KEY and probe the Codex endpoint").parse();

async function main(): Promise<void> {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey?.trim()) {
    console.error("Error: OPENAI_API_KEY is not set. Export it in your shell and re-run /codex:setup.");
    process.exit(2);
  }

  log.info("probing endpoint with API key");
  await authorize();

  console.log(`OK — OPENAI_API_KEY validated; endpoint reachable. Try /codex:review.`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("invalid") || msg.includes("401") || msg.includes("auth_failed")) {
    console.error(`Auth failed: ${msg}`);
    process.exit(2);
  }
  console.error(`Setup failed (network): ${msg}`);
  process.exit(4);
});
