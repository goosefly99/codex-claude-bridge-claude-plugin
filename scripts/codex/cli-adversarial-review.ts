#!/usr/bin/env node
/**
 * CLI entry point for /codex:adversarial-review — the general-purpose
 * adversarial review of arbitrary files or folders. Runs the same locked
 * 7-attack-surface taxonomy as /codex:adversarial-diff-review; only the input
 * shape differs.
 *
 * Exit codes: 0 success, 2 auth failure, 4 network/runtime, 5 no paths given,
 * 6 paths resolved to no reviewable content.
 *
 * For diff-scoped adversarial review, see cli-adversarial-diff-review.ts
 * (/codex:adversarial-diff-review).
 *
 * Background mode: spawns self as a detached child (CODEX_BRIDGE_JOB_ID in
 * env), which writes its result to the results directory on completion.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { program } from "commander";

import { runGeneralAdversarialReview, type AttackSurface } from "./adversarialEngine.js";
import { spawnDetached, writeJobResult } from "../concurrency/jobManager.js";
import { getLogger } from "../util/log.js";

const log = getLogger("cli-adversarial-review");

program
  .name("codex-bridge-adversarial-review")
  .description("Adversarial review of arbitrary files/folders across 7 hard-coded attack surfaces")
  .option("--effort <level>", "low | medium | high", "high")
  .option("--focus <surface>", "narrow to a single attack surface")
  .option("--question <text>", "user question or focus area")
  .option("--background", "force background execution")
  .option("--wait", "force synchronous execution")
  .argument("[paths...]", "one or more files or folders to review")
  .parse();

const opts = program.opts<{
  effort: "low" | "medium" | "high";
  focus?: string;
  question?: string;
  background?: boolean;
  wait?: boolean;
}>();
const paths = program.args;

const inheritedJobId = process.env["CODEX_BRIDGE_JOB_ID"];

async function main(): Promise<void> {
  if (paths.length === 0) {
    console.error(
      "no paths given. Use `/codex:adversarial-review <path...>` to review files or folders. " +
        "For diff review, use `/codex:adversarial-diff-review`.",
    );
    process.exit(5);
  }

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
    const result = await runGeneralAdversarialReview(paths, {
      effort: opts.effort,
      ...(opts.focus ? { focus: opts.focus as AttackSurface } : {}),
      ...(opts.question ? { question: opts.question } : {}),
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
  if (msg.includes("no reviewable files found")) {
    console.error(msg);
    process.exit(6);
  }
  console.error(`Adversarial review failed: ${msg}`);
  process.exit(4);
});
