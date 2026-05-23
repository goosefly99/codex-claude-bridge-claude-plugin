#!/usr/bin/env node
/**
 * CLI entry point for /codex:rescue.
 * Hands a Claude-authored plan to Codex for execution.
 * Exit 0 on success, 2 on auth/input failure, 4 on network.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { program } from "commander";

import { sendCompletion } from "./transport.js";
import { getLogger } from "../util/log.js";

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = resolve(dirname(__filename), "..", "..");

const log = getLogger("cli-rescue");

program
  .name("codex-bridge-rescue")
  .description("Hand a Claude-authored plan to Codex for execution")
  .argument("<plan>", "the plan or task description to execute")
  .parse();

const [plan] = program.args;

async function main(): Promise<void> {
  if (!plan?.trim()) {
    console.error("Error: a plan or task description is required. Usage: codex-bridge-rescue <plan>");
    process.exit(2);
  }

  const systemPath = resolve(PLUGIN_ROOT, "prompts", "rescue-system.md");
  const system = readFileSync(systemPath, "utf-8");

  log.info("dispatching rescue job");
  const result = await sendCompletion(
    [
      { role: "system", content: system },
      { role: "user", content: plan },
    ],
    { reasoning_effort: "high" },
  );

  console.log(result.message.content);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Rescue failed: ${msg}`);
  process.exit(4);
});
