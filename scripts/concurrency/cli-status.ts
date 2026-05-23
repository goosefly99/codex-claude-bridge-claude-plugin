#!/usr/bin/env node
/**
 * CLI entry point for /codex:status.
 * Read-only: surfaces active/queued jobs and undelivered background results.
 * Exit 0 always (status is informational, not an error condition).
 */
import { program } from "commander";

import {
  current,
  readUndeliveredResults,
  markResultDelivered,
  type JobDescriptor,
} from "./jobManager.js";

program.name("codex-bridge-status").description("Inspect active and queued Codex jobs").parse();

function elapsed(startedAt: string): string {
  const secs = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  return `${secs}s`;
}

function renderJob(j: JobDescriptor, prefix = ""): void {
  const state =
    j.state === "running"
      ? `running (${elapsed(j.started_at)} elapsed)`
      : j.state === "completed-pending-delivery"
        ? "completed — result pending delivery on next session refresh"
        : j.state;
  console.log(`${prefix}[${j.id.slice(0, 8)}] ${j.command} — ${state}`);
  if (j.started_at) console.log(`${prefix}  started : ${j.started_at}`);
  if (j.completed_at) console.log(`${prefix}  completed: ${j.completed_at}`);
  if (j.error) console.log(`${prefix}  error   : ${j.error}`);
}

async function main(): Promise<void> {
  const { commands, delegator } = await current();
  const undelivered = readUndeliveredResults();

  const hasCommands = commands.active.length > 0 || commands.queued.length > 0;
  const hasDelegator = delegator.active.length > 0 || delegator.queued.length > 0;
  const hasResults = undelivered.length > 0;

  if (!hasCommands && !hasDelegator && !hasResults) {
    console.log("idle — no active or queued jobs. Free to run any /codex: command.");
    return;
  }

  if (hasCommands) {
    console.log("=== Slash-command registry (depth-1 FIFO) ===");
    for (const j of commands.active) renderJob(j);
    for (const j of commands.queued) renderJob(j, "  [queued] ");
  }

  if (hasDelegator) {
    console.log("=== Delegator registry (parallel) ===");
    for (const j of delegator.active) renderJob(j);
    for (const j of delegator.queued) renderJob(j, "  [queued] ");
  }

  if (hasResults) {
    console.log("=== Completed background results ===");
    for (const r of undelivered) {
      console.log(`[${r.jobId.slice(0, 8)}] ${r.command} — completed at ${r.completed_at}`);
      if (r.error) {
        console.log(`  ERROR: ${r.error}`);
      } else {
        const preview = JSON.stringify(r.result);
        console.log(`  Result: ${preview.length > 200 ? preview.slice(0, 200) + "..." : preview}`);
      }
      markResultDelivered(r.jobId);
    }
  }
}

main().catch((err: unknown) => {
  console.error(`Status read failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0);
});
