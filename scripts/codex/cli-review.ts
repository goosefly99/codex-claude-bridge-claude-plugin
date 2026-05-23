#!/usr/bin/env node
/**
 * CLI entry point for /codex:review (neutral, non-adversarial).
 * Exit 0 on success, 2 on auth failure, 3 on no git repo, 4 on network.
 *
 * Background mode: spawns self as a detached child (CODEX_BRIDGE_JOB_ID in
 * env), which writes its result to the results directory on completion.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { program } from "commander";

import { runNeutralReview } from "./adversarialEngine.js";
import { spawnDetached, writeJobResult } from "../concurrency/jobManager.js";
import { getLogger } from "../util/log.js";

const log = getLogger("cli-review");

program
  .name("codex-bridge-review")
  .description("Neutral code review via Codex")
  .option("--effort <level>", "low | medium | high", "medium")
  .option("--background", "force background execution")
  .option("--wait", "force synchronous execution")
  .argument("[git-ref]", "optional git ref or refspec")
  .parse();

const opts = program.opts<{ effort: "low" | "medium" | "high"; background?: boolean; wait?: boolean }>();
const [gitRef] = program.args;

const inheritedJobId = process.env["CODEX_BRIDGE_JOB_ID"];

async function main(): Promise<void> {
  if (opts.background && !inheritedJobId) {
    const jobId = randomUUID();
    const selfPath = fileURLToPath(import.meta.url);
    const fwdArgs = [selfPath, ...process.argv.slice(2).filter((a) => a !== "--background")];
    spawnDetached(jobId, process.execPath, fwdArgs, { CODEX_BRIDGE_JOB_ID: jobId });
    log.info("detached background job launched", { jobId });
    console.log(`Background job started (id: ${jobId}). Run /codex:status to check progress.`);
    return;
  }

  try {
    const result = await runNeutralReview(gitRef, { effort: opts.effort });
    if (inheritedJobId) {
      writeJobResult(inheritedJobId, "codex:review", result);
    } else {
      console.log(result);
    }
  } catch (err) {
    if (inheritedJobId) {
      writeJobResult(
        inheritedJobId,
        "codex:review",
        undefined,
        err instanceof Error ? err.message : String(err),
      );
    }
    throw err;
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("no git repo") || msg.includes("git_state")) {
    console.error(`No git repo: ${msg}`);
    process.exit(3);
  }
  console.error(`Review failed: ${msg}`);
  process.exit(4);
});
