#!/usr/bin/env node
/**
 * CLI entry point for /codex:adversarial-review.
 * Exit 0 on success, 2 on auth failure, 3 on no git repo, 4 on network.
 *
 * Background mode: spawns self as a detached child (CODEX_BRIDGE_JOB_ID in
 * env), which writes its result to the results directory on completion.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { program } from "commander";

import { runAdversarialReview, type AttackSurface } from "./adversarialEngine.js";
import { spawnDetached, writeJobResult } from "../concurrency/jobManager.js";
import { getLogger } from "../util/log.js";

const log = getLogger("cli-adversarial");

program
  .name("codex-bridge-adversarial")
  .description("Adversarial code review across 7 hard-coded attack surfaces")
  .option("--effort <level>", "low | medium | high", "high")
  .option("--focus <surface>", "narrow to a single attack surface")
  .option("--background", "force background execution")
  .option("--wait", "force synchronous execution")
  .argument("[git-ref]", "optional git ref or refspec")
  .parse();

const opts = program.opts<{
  effort: "low" | "medium" | "high";
  focus?: string;
  background?: boolean;
  wait?: boolean;
}>();
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
    const result = await runAdversarialReview(gitRef, {
      effort: opts.effort,
      ...(opts.focus ? { focus: opts.focus as AttackSurface } : {}),
    });
    if (inheritedJobId) {
      writeJobResult(inheritedJobId, "codex:adversarial-review", result);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (err) {
    if (inheritedJobId) {
      writeJobResult(
        inheritedJobId,
        "codex:adversarial-review",
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
  console.error(`Adversarial review failed: ${msg}`);
  process.exit(4);
});
