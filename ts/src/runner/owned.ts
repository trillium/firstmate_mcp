/**
 * Owned calls (tool-attributed execution) + guards. (slice 25 of the runner.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/runner.ts. Exported there, re-exported via
 * runner.ts so the `./runner.js` public surface is unchanged.
 */
import { Effect } from "effect";
import { MAX_OUTPUT_BYTES } from "../constants.js";
import {
  SubprocessFailedError,
  type RunnerError,
} from "../errors.js";
import { RunnerService, runScript } from "./script.js";
import { byteLength, truncate } from "./types.js";
import type { RunError, RunResult } from "./types.js";

export interface OwnedOk {
  ok: true;
  stdout: string;
  stdout_truncated: boolean;
  stderr: string;
  stderr_truncated: boolean;
}

export type OwnedResult = OwnedOk | (RunError & { ok?: never });

/**
 * Effect core for owned calls: runs via the RunnerService and maps
 * nonzero exit to a typed SubprocessFailedError internally, then back to
 * the legacy fail-closed payload so the wire never changes.
 */
export function ownedCallEffect(
  argv: string[],
  label: string,
): Effect.Effect<{ payload: Record<string, unknown>; isError: boolean }, RunnerError, RunnerService> {
  return Effect.gen(function* () {
    const runner = yield* RunnerService;
    const res = yield* runner.run(argv);
    const [out, outTrunc] = truncate(res.stdout ?? "");
    const [errOut, errTrunc] = truncate(res.stderr ?? "");
    if (res.exitCode !== 0) {
      yield* Effect.fail(
        new SubprocessFailedError({
          label,
          exit: res.exitCode,
          stdout: out,
          stderr: errOut,
        }),
      );
    }
    return {
      payload: {
        ok: true,
        stdout: out,
        stdout_truncated: outTrunc,
        stderr: errOut,
        stderr_truncated: errTrunc,
      },
      isError: false as const,
    };
  }).pipe(
    Effect.catchAll((error) => {
      if (error._tag === "SubprocessFailedError") {
        return Effect.succeed({
          payload: {
            error: error.label,
            exit: error.exit,
            stdout: error.stdout,
            stderr: error.stderr,
          },
          isError: true as const,
        });
      }
      return Effect.fail(error as RunnerError);
    }),
  );
}

/** Shared fail-closed wrapper: nonzero exit stays a typed error. */
export async function ownedCall(
  argv: string[],
  label: string,
  run: typeof runScript = runScript,
): Promise<{ payload: Record<string, unknown>; isError: boolean }> {
  const res = await run(argv);
  if (!isRunResult(res)) {
    return { payload: res, isError: true };
  }
  const [out, outTrunc] = truncate(res.stdout ?? "");
  const [errOut, errTrunc] = truncate(res.stderr ?? "");
  if (res.exitCode !== 0) {
    return {
      payload: { error: label, exit: res.exitCode, stdout: out, stderr: errOut },
      isError: true,
    };
  }
  return {
    payload: {
      ok: true,
      stdout: out,
      stdout_truncated: outTrunc,
      stderr: errOut,
      stderr_truncated: errTrunc,
    },
    isError: false,
  };
}

export function isRunResult(value: RunResult | RunError): value is RunResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "exitCode" in value &&
    !("error" in value)
  );
}

export function outputTooLarge(text: string, cap: number = MAX_OUTPUT_BYTES): boolean {
  return byteLength(text) > cap;
}
