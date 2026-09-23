/**
 * Throwing require_* wrappers + their imports. (slice 20 of the validators.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/validators.ts. Exported there, re-exported via
 * validators.ts so the `./validators.js` public surface is unchanged.
 */
import { Effect } from "effect";
import {
  ApprovalInvalidError,
  ApprovalRequiredError,
  ValidationError,
} from "../errors.js";
import { byteLength } from "../runner.js";
import { confineStatePath } from "./paths.js";
import { validApproval, validId, validNote, validProject } from "./core.js";

/** Require a valid task/id slug, else a typed invalid-id error. */
export function requireId(
  value: unknown,
  code = "invalid id",
  expect = "short task id, no slashes or traversal",
): Effect.Effect<string, ValidationError> {
  if (validId(value)) return Effect.succeed(value);
  return Effect.fail(new ValidationError({ code, expect }));
}

/** Require a valid project, else a typed invalid-project error. */
export function requireProject(
  value: unknown,
): Effect.Effect<string, ValidationError> {
  if (validProject(value)) return Effect.succeed(value);
  return Effect.fail(
    new ValidationError({
      code: "invalid project",
      expect: "bare name or projects/<name>, no absolute paths or traversal",
    }),
  );
}

/** Require a single-line note within cap, else a typed error. */
export function requireNote(
  value: unknown,
  code: string,
  cap: number,
  expect: string,
): Effect.Effect<string, ValidationError> {
  if (validNote(value, cap)) return Effect.succeed(value);
  return Effect.fail(new ValidationError({ code, expect }));
}

/** Require explicit "I authorize" approval, else a typed approval error. */
export function requireApproval(
  value: unknown,
): Effect.Effect<string, ApprovalRequiredError | ApprovalInvalidError> {
  if (validApproval(value)) return Effect.succeed(value);
  if (value === undefined || value === null) {
    return Effect.fail(
      new ApprovalRequiredError({
        expect: "explicit approval string starting with 'I authorize'",
      }),
    );
  }
  return Effect.fail(
    new ApprovalInvalidError({
      expect: "explicit approval string starting with 'I authorize'",
    }),
  );
}

/** Require a confined state path, else a typed invalid-id error. */
export function requireStatePath(
  stateDir: string,
  taskId: unknown,
): Effect.Effect<string, ValidationError> {
  const confined = confineStatePath(stateDir, taskId);
  if (confined !== null) return Effect.succeed(confined);
  return Effect.fail(
    new ValidationError({
      code: "invalid id",
      expect: "short task id, no slashes or traversal",
    }),
  );
}
