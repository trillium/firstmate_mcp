/**
 * Fail-closed subprocess runner (Effect composition).
 *
 * Contract: every tool script runs with SUBPROCESS_TIMEOUT_S=30 and a
 * MAX_OUTPUT_BYTES=1MB envelope. Receipt continuations (receipt_submit)
 * run detached with RECEIPT_TIMEOUT_S=180 while the caller stays unblocked. Children start at the head of their own
 * process group (detached) so a timeout can reclaim the whole descendant
 * tree — a bare child-kill would leave fm-*.sh per-task grandchildren
 * running as orphans. On timeout the group gets SIGTERM, a short grace
 * period, then SIGKILL.
 *
 * Effect structure: the lifecycle is an Effect.acquireRelease scope
 * (spawn on acquire, process-group kill on release) with an
 * Effect.timeoutFail boundary. Failures travel as typed errors
 * (ExecutableNotFoundError / SubprocessTimeoutError) instead of thrown
 * exceptions. The Promise wrappers (runScript / ownedCall) preserve the
 * exact legacy shapes so the stdio wire stays byte-identical.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { Context, Duration, Effect, Layer } from "effect";
import {
  CHECKOUT_ROOT,
  MAX_OUTPUT_BYTES,
  PROCESS_GROUP_GRACE_S,
  SUBPROCESS_TIMEOUT_S,
  TAIL_CAP_BYTES,
} from "./constants.js";
import {
  ExecutableNotFoundError,
  SubprocessFailedError,
  SubprocessTimeoutError,
  type RunnerError,
} from "./errors.js";

// Run types + helpers live in ./runner/types.ts (slice 25, task-8pqjb).
import {
  RunResult,
  RunError,
  byteLength,
  truncate,
} from "./runner/types.js";
export {
  RunResult,
  RunError,
  byteLength,
  truncate,
};
// Process helpers (sleepMs, killProcessGroup) live in ./runner/process.ts (slice 25).
// Private to that module except killProcessGroupEffect, used by script.ts.
// Script execution + service live in ./runner/script.ts (slice 25, task-8pqjb).
import {
  RunnerOptions,
  runScriptEffect,
  RunnerApi,
  RunnerService,
  RunnerLive,
  makeTestRunnerLayer,
  runnerErrorToRunError,
  runScript,
} from "./runner/script.js";
export {
  RunnerOptions,
  runScriptEffect,
  RunnerApi,
  RunnerService,
  RunnerLive,
  makeTestRunnerLayer,
  runnerErrorToRunError,
  runScript,
};
// Owned calls + guards live in ./runner/owned.ts (slice 25, task-8pqjb).
import {
  OwnedOk,
  OwnedResult,
  ownedCallEffect,
  ownedCall,
  isRunResult,
  outputTooLarge,
} from "./runner/owned.js";
export {
  OwnedOk,
  OwnedResult,
  ownedCallEffect,
  ownedCall,
  isRunResult,
  outputTooLarge,
};
