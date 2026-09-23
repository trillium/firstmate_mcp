/**
 * Path extraction + condition evaluation. (slice 19 of the followon.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/followon.ts. Exported there, re-exported via
 * followon.ts so the `./followon.js` public surface is unchanged.
 */
import { Effect } from "effect";
import type {
  Condition,
  ConditionOperator,
  FollowOnContext,
} from "./types.js";

/** Extract a nested property by dot notation path (e.g. "payload.records.0.id" or "args.task_id"). */
export function extractPath(source: unknown, pathStr: string): unknown {
  if (source === null || source === undefined) return undefined;
  const parts = pathStr.replace(/\[(\w+)\]/g, ".$1").split(".").filter(Boolean);
  let current: unknown = source;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Extract value from FollowOnContext with convenient root fallbacks. */
export function extractFromContext(ctx: FollowOnContext, fieldPath: string): unknown {
  if (fieldPath === "isError") return ctx.origin.isError;
  if (fieldPath === "tool") return ctx.origin.tool;
  if (fieldPath === "depth") return ctx.depth;
  if (fieldPath === "traceId") return ctx.traceId;

  // Explicit path prefixes
  if (fieldPath.startsWith("origin.")) {
    return extractPath(ctx.origin, fieldPath.slice(7));
  }
  if (fieldPath.startsWith("payload.")) {
    return extractPath(ctx.origin.payload, fieldPath.slice(8));
  }
  if (fieldPath.startsWith("args.")) {
    return extractPath(ctx.origin.args, fieldPath.slice(5));
  }
  if (fieldPath.startsWith("previous.")) {
    return extractPath(ctx.previous, fieldPath.slice(9));
  }
  if (fieldPath.startsWith("env.")) {
    return extractPath(ctx.env, fieldPath.slice(4));
  }
  if (fieldPath.startsWith("chain.")) {
    return extractPath(ctx.chain, fieldPath.slice(6));
  }

  // Direct property on context root
  const direct = extractPath(ctx, fieldPath);
  if (direct !== undefined) return direct;

  // Fallbacks: bare property on payload, args, env
  const fromPayload = extractPath(ctx.origin.payload, fieldPath);
  if (fromPayload !== undefined) return fromPayload;

  const fromArgs = extractPath(ctx.origin.args, fieldPath);
  if (fromArgs !== undefined) return fromArgs;

  const fromPrevPayload = extractPath(ctx.previous.payload, fieldPath);
  if (fromPrevPayload !== undefined) return fromPrevPayload;

  const fromEnv = extractPath(ctx.env, fieldPath);
  if (fromEnv !== undefined) return fromEnv;

  return undefined;
}

/** Evaluate a single field condition against extracted value. */
export function evaluateFieldCondition(extracted: unknown, op: ConditionOperator, target: unknown): boolean {
  switch (op) {
    case "equals":
    case "eq":
      return extracted === target;
    case "not_equals":
    case "neq":
      return extracted !== target;
    case "contains":
      if (typeof extracted === "string" && typeof target === "string") {
        return extracted.includes(target);
      }
      if (Array.isArray(extracted)) {
        return extracted.includes(target);
      }
      return false;
    case "not_contains":
      return !evaluateFieldCondition(extracted, "contains", target);
    case "starts_with":
      return typeof extracted === "string" && typeof target === "string" && extracted.startsWith(target);
    case "ends_with":
      return typeof extracted === "string" && typeof target === "string" && extracted.endsWith(target);
    case "in":
      return Array.isArray(target) && target.includes(extracted);
    case "not_in":
      return Array.isArray(target) && !target.includes(extracted);
    case "greater_than":
    case "gt":
      return typeof extracted === "number" && typeof target === "number" && extracted > target;
    case "greater_than_or_equal":
    case "gte":
      return typeof extracted === "number" && typeof target === "number" && extracted >= target;
    case "less_than":
    case "lt":
      return typeof extracted === "number" && typeof target === "number" && extracted < target;
    case "less_than_or_equal":
    case "lte":
      return typeof extracted === "number" && typeof target === "number" && extracted <= target;
    case "exists":
      return extracted !== undefined && extracted !== null;
    case "not_exists":
      return extracted === undefined || extracted === null;
    case "truthy":
      return Boolean(extracted);
    case "falsy":
      return !Boolean(extracted);
    case "regex":
      try {
        const re = target instanceof RegExp ? target : new RegExp(String(target));
        return re.test(String(extracted ?? ""));
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/** Evaluate any Condition (field, and, or, not, or functional predicate) as an Effect. */
export function evaluateConditionEffect(
  condition: Condition | undefined,
  ctx: FollowOnContext,
): Effect.Effect<boolean, never, never> {
  if (condition === undefined) return Effect.succeed(true);

  // Functional predicate
  if (typeof condition === "function") {
    return Effect.tryPromise({
      try: async () => {
        const result = condition(ctx);
        if (typeof result === "boolean") return result;
        if (result instanceof Promise) return await result;
        return await Effect.runPromise(result as Effect.Effect<boolean, never, never>);
      },
      catch: () => false,
    }).pipe(Effect.catchAll(() => Effect.succeed(false)));
  }

  // And condition
  if ("and" in condition && Array.isArray(condition.and)) {
    if (condition.and.length === 0) return Effect.succeed(true);
    return Effect.gen(function* () {
      for (const cond of condition.and) {
        const match = yield* evaluateConditionEffect(cond, ctx);
        if (!match) return false;
      }
      return true;
    });
  }

  // Or condition
  if ("or" in condition && Array.isArray(condition.or)) {
    if (condition.or.length === 0) return Effect.succeed(false);
    return Effect.gen(function* () {
      for (const cond of condition.or) {
        const match = yield* evaluateConditionEffect(cond, ctx);
        if (match) return true;
      }
      return false;
    });
  }

  // Not condition
  if ("not" in condition && condition.not !== undefined) {
    return evaluateConditionEffect(condition.not, ctx).pipe(Effect.map((res: boolean) => !res));
  }

  // Field condition
  if ("field" in condition && "operator" in condition) {
    const val = extractFromContext(ctx, condition.field);
    const matched = evaluateFieldCondition(val, condition.operator, condition.value);
    return Effect.succeed(matched);
  }

  return Effect.succeed(true);
}
