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

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface RunError {
  error: string;
  [key: string]: unknown;
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Bound a script output tail; returns [text, wasTruncated]. */
export function truncate(text: string, cap: number = TAIL_CAP_BYTES): [string, boolean] {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= cap) return [text, false];
  return [buf.subarray(0, cap).toString("utf8") + "\n…[truncated]", true];
}

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
function killProcessGroupEffect(child: ChildProcess): Effect.Effect<void> {
  return Effect.promise(() => killProcessGroup(child)).pipe(Effect.ignore);
}

export interface RunnerOptions {
  timeoutS?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
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
