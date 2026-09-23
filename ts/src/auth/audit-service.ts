/**
 * Effect service, layers, check/append effects. (slice 23 of the auth.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/auth.ts. Exported there, re-exported via
 * auth.ts so the `./auth.js` public surface is unchanged.
 */
import { Context, Effect, Layer } from "effect";
import {
  ApprovalInvalidError,
  ApprovalRequiredError,
  AuditError,
  ForbiddenToolError,
  UnknownToolError,
} from "../errors.js";
import {
  check,
  tierOf,
  validApproval,
} from "./tier-check.js";
import {
  TIER_FORBIDDEN,
  TIER_OPEN,
  TIER_STEER,
  type Tier,
} from "./tiers.js";
import { appendAudit, type AuditLine } from "./audit-log.js";

export type AuthCheckError =
  | UnknownToolError
  | ForbiddenToolError
  | ApprovalRequiredError
  | ApprovalInvalidError;

/** Effect core: tier check with typed errors instead of tuples. */
export function checkEffect(
  tool: string,
  approval?: unknown,
  grantRef?: string | null,
): Effect.Effect<void, AuthCheckError> {
  const tier = tierOf(tool);
  if (tier === null) {
    return Effect.fail(new UnknownToolError({ tool }));
  }
  if (tier === TIER_FORBIDDEN) {
    return Effect.fail(new ForbiddenToolError({ tool }));
  }
  if (tier === TIER_OPEN || tier === TIER_STEER) {
    return Effect.void;
  }
  if (validApproval(approval) || (typeof grantRef === "string" && grantRef.length > 0)) {
    return Effect.void;
  }
  if (approval === undefined || approval === null) {
    return Effect.fail(
      new ApprovalRequiredError({
        expect: "explicit approval string starting with 'I authorize' or valid standing grant",
      }),
    );
  }
  return Effect.fail(
    new ApprovalInvalidError({
      expect: "explicit approval string starting with 'I authorize' or valid standing grant",
    }),
  );
}

/** Effect core: best-effort audit append with a typed error channel. */
export function appendAuditEffect(
  filePath: string,
  line: AuditLine,
): Effect.Effect<string, AuditError> {
  return Effect.try({
    try: () => appendAudit(filePath, line),
    catch: (exc) => new AuditError({ detail: String(exc) }),
  });
}

export interface AuditApi {
  readonly append: (
    filePath: string,
    line: AuditLine,
  ) => Effect.Effect<string, AuditError>;
  readonly check: (
    tool: string,
    approval?: unknown,
  ) => Effect.Effect<void, AuthCheckError>;
}

export class AuditService extends Context.Tag("AuditService")<
  AuditService,
  AuditApi
>() {}

/** Live audit: file appends + pure tier checks. */
export const AuditLive: Layer.Layer<AuditService> = Layer.succeed(
  AuditService,
  AuditService.of({
    append: (filePath, line) => appendAuditEffect(filePath, line),
    check: (tool, approval) => checkEffect(tool, approval),
  }),
);

/** Test audit layer (records lines in memory, never touches disk). */
export function makeTestAuditLayer(
  lines: AuditLine[] = [],
): Layer.Layer<AuditService> {
  return Layer.succeed(
    AuditService,
    AuditService.of({
      append: (filePath, line) =>
        Effect.sync(() => {
          lines.push(line);
          return filePath;
        }),
      check: (tool, approval) => checkEffect(tool, approval),
    }),
  );
}
