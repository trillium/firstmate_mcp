/**
 * Sleep + process-group kill (promise + Effect). (slice 25 of the runner.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/runner.ts. Exported there, re-exported via
 * runner.ts so the `./runner.js` public surface is unchanged.
 */
import { type ChildProcess } from "node:child_process";
import { Effect } from "effect";
import { PROCESS_GROUP_GRACE_S } from "../constants.js";

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killProcessGroup(child: ChildProcess, graceS: number = PROCESS_GROUP_GRACE_S): Promise<void> {
  return (async () => {
    if (child.pid === undefined || child.exitCode !== null) return;
    try {
      // Negative pid targets the whole group (child was spawned detached).
      process.kill(-child.pid, "SIGTERM");
    } catch {
      return;
    }
    const deadline = Date.now() + graceS * 1000;
    while (child.exitCode === null && Date.now() < deadline) {
      await sleepMs(50);
    }
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  })();
}

/** Effect finalizer for a spawned child (best-effort group kill). */
export function killProcessGroupEffect(child: ChildProcess): Effect.Effect<void> {
  return Effect.promise(() => killProcessGroup(child)).pipe(Effect.ignore);
}

