/**
 * Script execution (promise + Effect) + service/layers. (slice 25 of the runner.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/runner.ts. Exported there, re-exported via
 * runner.ts so the `./runner.js` public surface is unchanged.
 */
import { spawn } from "node:child_process";
import { Context, Duration, Effect, Layer } from "effect";
import { killProcessGroupEffect } from "./process.js";
import type { RunError, RunResult } from "./types.js";
import {
  CHECKOUT_ROOT,
  MAX_OUTPUT_BYTES,
  SUBPROCESS_TIMEOUT_S,
} from "../constants.js";
import {
  ExecutableNotFoundError,
  SubprocessFailedError,
  SubprocessTimeoutError,
  type RunnerError,
} from "../errors.js";

export interface RunnerOptions {
  timeoutS?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Optional stdin payload (mail-send body); piped, never argv. */
  input?: string;
}

/**
 * Effect core: run argv to completion inside a managed scope.
 * Acquire spawns the detached child; release kills the process group;
 * the timeout boundary maps to a typed SubprocessTimeoutError.
 */
export function runScriptEffect(
  argv: string[],
  opts: RunnerOptions = {},
): Effect.Effect<RunResult, RunnerError> {
  const timeoutS = opts.timeoutS ?? SUBPROCESS_TIMEOUT_S;
  const cwd = opts.cwd ?? CHECKOUT_ROOT;
  const env = opts.env ?? process.env;
  const input = opts.input;
  const scoped = Effect.scoped(
    Effect.gen(function* () {
      const child = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            spawn(argv[0], argv.slice(1), {
              cwd,
              env,
              detached: true,
              windowsHide: true,
            }),
          catch: (exc) =>
            new ExecutableNotFoundError({ detail: String(exc) }),
        }),
        (child) => killProcessGroupEffect(child),
      );
      const result = yield* Effect.async<RunResult, RunnerError>(
        (resume) => {
          let stdout = "";
          let stderr = "";
          child.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
          });
          // Piped stdin (mail-send body): written once, then closed so
          // the child never blocks on an open pipe. Untouched otherwise.
          if (input !== undefined) {
            try {
              child.stdin?.write(input);
            } catch {
              /* child already gone; close carries the outcome */
            }
            try {
              child.stdin?.end();
            } catch {
              /* already closed */
            }
          }
          child.on("error", (exc: Error & { code?: string }) => {
            resume(
              Effect.fail(
                new ExecutableNotFoundError({ detail: String(exc) }),
              ),
            );
          });
          child.on("close", (code) => {
            // Fail-closed timeout wins: a SIGTERM-killed shell reports
            // close with exitCode null, which must surface as the typed
            // timeout error rather than a downstream script failure.
            // Mirrors the timedOut guard in the legacy Promise runner.
            if (code === null) {
              resume(
                Effect.fail(new SubprocessTimeoutError({ timeoutS })),
              );
              return;
            }
            resume(Effect.succeed({ stdout, stderr, exitCode: code }));
          });
        },
      );
      return result;
    }),
  );
  return scoped.pipe(
    Effect.timeoutFail({
      duration: Duration.seconds(timeoutS),
      onTimeout: () => new SubprocessTimeoutError({ timeoutS }),
    }),
  );
}

// --- Runner Service / Layers ---

export interface RunnerApi {
  readonly run: (
    argv: string[],
    opts?: RunnerOptions,
  ) => Effect.Effect<RunResult, RunnerError>;
}

export class RunnerService extends Context.Tag("RunnerService")<
  RunnerService,
  RunnerApi
>() {}

/** Live runner: Effect-managed subprocess lifecycle. */
export const RunnerLive: Layer.Layer<RunnerService> = Layer.succeed(
  RunnerService,
  RunnerService.of({
    run: (argv, opts) => runScriptEffect(argv, opts),
  }),
);

/** Test runner layer from an explicit implementation (hermetic fixtures). */
export function makeTestRunnerLayer(
  run: RunnerApi["run"],
): Layer.Layer<RunnerService> {
  return Layer.succeed(RunnerService, RunnerService.of({ run }));
}

/** Map a typed runner error back to the legacy RunError shape. */
export function runnerErrorToRunError(error: RunnerError): RunError {
  if (error._tag === "ExecutableNotFoundError") {
    return { error: "executable not found", detail: error.detail };
  }
  return { error: "timed out", timeout_s: error.timeoutS };
}

/**
 * Run argv to completion. Resolves with the result, or with a typed
 * RunError when the executable is missing or the timeout fires.
 *
 * Implemented on the Effect core (runScriptEffect) so the process-group
 * lifecycle is scope-managed even through this legacy Promise signature.
 */
export function runScript(argv: string[], opts: RunnerOptions = {}): Promise<RunResult | RunError> {
  return Effect.runPromise(
    runScriptEffect(argv, opts).pipe(
      Effect.catchAll((error) =>
        Effect.succeed(runnerErrorToRunError(error)),
      ),
    ),
  );
}

