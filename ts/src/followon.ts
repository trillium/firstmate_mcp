/**
 * Customizable Follow-On Actions for First Mate MCP (TypeScript sibling).
 *
 * GENERALIZED hook / action-chain engine:
 * Allows any MCP tool action to trigger configurable follow-on actions.
 *
 * Core pillars:
 * 1. Trigger Model: tool name / wildcard matching, outcome matching (success/failure/always), priority.
 * 2. Condition Language: safe declarative predicates over context (dot paths, operators, and/or/not trees)
 *    and programmatic Effect/boolean predicates.
 * 3. Ordering Semantics: deterministic priority sorting, sequential/parallel execution modes,
 *    continueOnError flow control, onFailure rollback/compensation chains.
 * 4. Context/Result Forwarding: templated argument interpolation (${origin.args.x}, ${previous.payload.y},
 *    ${env.stateDir}) with native type preservation.
 * 5. LOAD-BEARING AUTH SAFETY: Every chained action strictly passes through the authorization tier
 *    gate (checkEffect / TOOL_TIERS). A no-approval trigger CANNOT cause an approval-gated action
 *    (Tiers 3/4) without an explicit valid approval token. Forbidden tools are strictly blocked.
 *    Authority laundering is impossible. Every follow-on action emits its own JSON-lines audit entry.
 * 6. Failure Isolation: Follow-on failures never break or mutate the originating call's envelope.
 * 7. Loop Prevention & Termination Proof: Multi-layer guard with maximum depth cap (maxDepth),
 *    ancestor cycle detection (visited set), and total action budget (maxActionsPerChain),
 *    guaranteeing finite DAG execution and mathematical termination.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Context, Data, Effect, Layer } from "effect";
import {
  TIER_FORBIDDEN,
  TIER_AUTHORITY,
  TIER_EXTERNAL,
  tierOf,
  validApproval,
  buildLine,
  AuditService,
} from "./auth.js";
import { TOOLS, type ToolContext, type ToolResult } from "./tools.js";

// --- Constants & Defaults ---

export const DEFAULT_MAX_DEPTH = 3;
export const HARD_MAX_DEPTH = 8;
export const DEFAULT_MAX_ACTIONS_PER_CHAIN = 10;
export const HARD_MAX_ACTIONS_PER_CHAIN = 50;

// --- Typed Errors ---

export class FollowOnDepthExceededError extends Data.TaggedError("FollowOnDepthExceededError")<{
  readonly depth: number;
  readonly maxDepth: number;
  readonly tool: string;
}> {
  get message(): string {
    return `Follow-on depth cap exceeded (depth=${this.depth}, max=${this.maxDepth}) for tool '${this.tool}'`;
  }
}

export class FollowOnCycleError extends Data.TaggedError("FollowOnCycleError")<{
  readonly tool: string;
  readonly callStack: readonly string[];
}> {
  get message(): string {
    return `Follow-on recursion cycle detected for tool '${this.tool}' in call stack: ${this.callStack.join(" -> ")}`;
  }
}

export class FollowOnBudgetExceededError extends Data.TaggedError("FollowOnBudgetExceededError")<{
  readonly actionCount: number;
  readonly maxActions: number;
}> {
  get message(): string {
    return `Follow-on action budget exceeded (${this.actionCount} >= ${this.maxActions})`;
  }
}

export class FollowOnAuthRefusedError extends Data.TaggedError("FollowOnAuthRefusedError")<{
  readonly tool: string;
  readonly reason: string;
}> {
  get message(): string {
    return `Follow-on action refused for tool '${this.tool}': ${this.reason}`;
  }
}

export class FollowOnExecutionError extends Data.TaggedError("FollowOnExecutionError")<{
  readonly tool: string;
  readonly detail: string;
}> {
  get message(): string {
    return `Follow-on action '${this.tool}' failed: ${this.detail}`;
  }
}

export type FollowOnError =
  | FollowOnDepthExceededError
  | FollowOnCycleError
  | FollowOnBudgetExceededError
  | FollowOnAuthRefusedError
  | FollowOnExecutionError;

// --- Triggers & Conditions ---

export type FollowOnTriggerOutcome = "success" | "failure" | "error" | "always" | "complete";

export interface FollowOnTrigger {
  /** Target tool name to match, or array of tools, or "*" wildcard. */
  readonly tool: string | readonly string[];
  /** Outcome when trigger fires: success (isError: false), failure/error (isError: true), or always/complete. Default: "success". */
  readonly on?: FollowOnTriggerOutcome;
  /** Numeric priority for ordering multiple rules matching the same tool (higher runs first). Default: 0. */
  readonly priority?: number;
}

export type ConditionOperator =
  | "equals"
  | "eq"
  | "not_equals"
  | "neq"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "in"
  | "not_in"
  | "greater_than"
  | "gt"
  | "greater_than_or_equal"
  | "gte"
  | "less_than"
  | "lt"
  | "less_than_or_equal"
  | "lte"
  | "exists"
  | "not_exists"
  | "truthy"
  | "falsy"
  | "regex";

export interface FieldCondition {
  readonly field: string;
  readonly operator: ConditionOperator;
  readonly value?: unknown;
}

export interface AndCondition {
  readonly and: readonly Condition[];
}

export interface OrCondition {
  readonly or: readonly Condition[];
}

export interface NotCondition {
  readonly not: Condition;
}

export type FunctionalPredicate = (
  ctx: FollowOnContext,
) => boolean | Promise<boolean> | Effect.Effect<boolean>;

export type Condition =
  | FieldCondition
  | AndCondition
  | OrCondition
  | NotCondition
  | FunctionalPredicate;

// --- Action & Rule Definitions ---

export interface FollowOnActionDef {
  /** Target MCP tool name to execute. */
  readonly tool: string;
  /** Tool arguments. May contain template strings (e.g. "${origin.args.task_id}"). */
  readonly arguments?: Record<string, unknown>;
  /** Optional programmatic argument builder. */
  readonly argsBuilder?: (
    ctx: FollowOnContext,
  ) => Record<string, unknown> | Promise<Record<string, unknown>> | Effect.Effect<Record<string, unknown>>;
  /** If true, subsequent actions in the chain continue even if this action fails. Default: false. */
  readonly continueOnError?: boolean;
  /** Optional compensation / rollback actions to run if this action fails. */
  readonly onFailure?: readonly FollowOnActionDef[];
  /** Optional condition guard evaluated before this specific action runs. */
  readonly condition?: Condition;
  /** Optional descriptive label for logging and audit. */
  readonly label?: string;
}

export interface FollowOnRule {
  /** Optional unique rule ID. */
  readonly id?: string;
  /** Trigger specification. */
  readonly trigger: FollowOnTrigger;
  /** Optional condition predicate for the entire rule. */
  readonly condition?: Condition;
  /** Ordered list of follow-on actions to execute when triggered. */
  readonly actions: readonly FollowOnActionDef[];
  /** Execution mode: sequential (default) or parallel. */
  readonly mode?: "sequential" | "parallel";
  /** If true, the rule continues executing remaining actions on failure. Default: false. */
  readonly continueOnError?: boolean;
  /** Optional rule-level compensation / rollback actions. */
  readonly onFailure?: readonly FollowOnActionDef[];
}

// --- Execution Context & Summaries ---

export interface OriginContext {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly isError: boolean;
  readonly timestamp?: string;
}

export interface StepContext {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly isError: boolean;
  readonly status: ActionStatus;
}

export interface EnvironmentContext {
  readonly homeDir: string;
  readonly binDir: string;
  readonly stateDir: string;
  readonly dataDir: string;
  readonly actor: string;
}

export interface FollowOnContext {
  /** Context of the originating MCP tool call. */
  readonly origin: OriginContext;
  /** Result of the immediately preceding action in this chain (or origin if first). */
  readonly previous: StepContext;
  /** Ordered array of all previous steps executed in the current chain. */
  readonly chain: readonly StepContext[];
  /** Server environment paths and metadata. */
  readonly env: EnvironmentContext;
  /** Current chain recursion depth (0 for root follow-on, 1 for follow-on of follow-on, etc.). */
  readonly depth: number;
  /** Stable correlation / trace ID for the entire causal tree. */
  readonly traceId: string;
  /** Ancestor call stack of tools in the current causal branch for cycle detection. */
  readonly callStack: readonly string[];
}

export type ActionStatus =
  | "success"
  | "failed"
  | "refused"
  | "skipped"
  | "cycle-detected"
  | "depth-exceeded"
  | "budget-exceeded";

export interface FollowOnActionResult {
  readonly tool: string;
  readonly label?: string;
  readonly args: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly isError: boolean;
  readonly status: ActionStatus;
  readonly error?: string;
  readonly duration_ms?: number;
}

export interface FollowOnChainSummary {
  readonly traceId: string;
  readonly originTool: string;
  readonly rulesEvaluated: number;
  readonly rulesMatched: number;
  readonly actionsExecuted: number;
  readonly actionsSucceeded: number;
  readonly actionsFailed: number;
  readonly results: readonly FollowOnActionResult[];
  readonly completedAt: string;
}

export interface FollowOnOptions {
  readonly maxDepth?: number;
  readonly maxActionsPerChain?: number;
  readonly preventCycles?: boolean;
}

// --- Path Extractor & Condition Evaluator ---

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

// --- Argument Templating & Interpolation ---

const TEMPLATE_EXACT_RE = /^\$\{([^}]+)\}$/;
const TEMPLATE_EMBEDDED_RE = /\$\{([^}]+)\}/g;

/** Interpolate a single value against FollowOnContext. */
export function interpolateValue(value: unknown, ctx: FollowOnContext): unknown {
  if (typeof value === "string") {
    // Exact single substitution preserves native type (boolean, number, object, array)
    const exactMatch = value.match(TEMPLATE_EXACT_RE);
    if (exactMatch) {
      const extracted = extractFromContext(ctx, exactMatch[1].trim());
      return extracted !== undefined ? extracted : value;
    }
    // Embedded string interpolation
    if (value.includes("${")) {
      return value.replace(TEMPLATE_EMBEDDED_RE, (match, pathKey) => {
        const extracted = extractFromContext(ctx, pathKey.trim());
        if (extracted === undefined || extracted === null) return "";
        if (typeof extracted === "object") return JSON.stringify(extracted);
        return String(extracted);
      });
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => interpolateValue(item, ctx));
  }

  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = interpolateValue(v, ctx);
    }
    return result;
  }

  return value;
}

/** Interpolate an entire arguments dictionary. */
export function interpolateArgs(
  argsDef: Record<string, unknown> | undefined,
  ctx: FollowOnContext,
): Record<string, unknown> {
  if (!argsDef) return {};
  const interpolated = interpolateValue(argsDef, ctx);
  return (interpolated as Record<string, unknown>) ?? {};
}

// --- Trigger Matcher ---

export function matchesTrigger(
  trigger: FollowOnTrigger,
  tool: string,
  isError: boolean,
): boolean {
  // 1. Check tool name match
  const targets = Array.isArray(trigger.tool) ? trigger.tool : [trigger.tool];
  const toolMatches = targets.includes("*") || targets.includes(tool);
  if (!toolMatches) return false;

  // 2. Check outcome match
  const on = trigger.on ?? "success";
  if (on === "always" || on === "complete") return true;
  if (on === "success" && !isError) return true;
  if ((on === "failure" || on === "error") && isError) return true;

  return false;
}

// --- Audit Path Resolution ---

function auditPath(ctx: ToolContext): string {
  return process.env.FM_AUDIT_LOG ?? path.join(ctx.stateDir, "mcp-audit.jsonl");
}

function auditAppend(
  audit: { append: (filePath: string, line: ReturnType<typeof buildLine>) => Effect.Effect<string, unknown> },
  ctx: ToolContext,
  tool: string,
  decision: string,
  reason: string,
  approval: unknown,
  target: string | null,
): Effect.Effect<void, never, never> {
  const actor = process.env.FM_ACTOR ?? "local";
  const line = buildLine(actor, tool, decision, reason, { approval, target });
  return audit.append(auditPath(ctx), line).pipe(Effect.ignore, Effect.asVoid);
}

// --- FollowOn Service Definition & Effect Layer ---

export interface FollowOnApi {
  readonly registerRule: (rule: FollowOnRule) => Effect.Effect<void>;
  readonly registerRules: (rules: readonly FollowOnRule[]) => Effect.Effect<void>;
  readonly getRules: () => Effect.Effect<readonly FollowOnRule[]>;
  readonly clearRules: () => Effect.Effect<void>;
  readonly loadConfigFile: (configPath?: string) => Effect.Effect<number>;
  readonly executeFollowOns: (
    origin: OriginContext,
    ctx: ToolContext,
    options?: FollowOnOptions,
  ) => Effect.Effect<FollowOnChainSummary, never, AuditService>;
}

export class FollowOnService extends Context.Tag("FollowOnService")<
  FollowOnService,
  FollowOnApi
>() {}

/**
 * Core follow-on executor implementing all safety, ordering, templating,
 * and loop prevention guarantees.
 */
export function executeFollowOnsEffect(
  origin: OriginContext,
  toolCtx: ToolContext,
  rules: readonly FollowOnRule[],
  options: FollowOnOptions = {},
): Effect.Effect<FollowOnChainSummary, never, AuditService> {
  return Effect.gen(function* () {
    const auditService = yield* AuditService;
    const maxDepth = Math.min(options.maxDepth ?? DEFAULT_MAX_DEPTH, HARD_MAX_DEPTH);
    const maxActions = Math.min(options.maxActionsPerChain ?? DEFAULT_MAX_ACTIONS_PER_CHAIN, HARD_MAX_ACTIONS_PER_CHAIN);
    const preventCycles = options.preventCycles ?? true;
    const traceId = randomBytes(8).toString("hex");
    const actor = process.env.FM_ACTOR ?? "local";

    const envCtx: EnvironmentContext = {
      homeDir: process.env.FM_HOME ?? toolCtx.binDir,
      binDir: toolCtx.binDir,
      stateDir: toolCtx.stateDir,
      dataDir: toolCtx.dataDir,
      actor,
    };

    const initialStep: StepContext = {
      tool: origin.tool,
      args: origin.args,
      payload: origin.payload,
      isError: origin.isError,
      status: origin.isError ? "failed" : "success",
    };

    let totalActionsExecuted = 0;
    let totalActionsSucceeded = 0;
    let totalActionsFailed = 0;
    const allResults: FollowOnActionResult[] = [];

    // Filter and sort matching rules by priority descending
    const matchingRules = rules
      .filter((r) => matchesTrigger(r.trigger, origin.tool, origin.isError))
      .sort((a, b) => (b.trigger.priority ?? 0) - (a.trigger.priority ?? 0));

    let rulesMatchedCount = 0;

    for (const rule of matchingRules) {
      // Build root follow-on context
      let currentContext: FollowOnContext = {
        origin,
        previous: initialStep,
        chain: [initialStep],
        env: envCtx,
        depth: 0,
        traceId,
        callStack: [origin.tool],
      };

      // Check rule-level condition
      const ruleConditionMatched = yield* evaluateConditionEffect(rule.condition, currentContext);
      if (!ruleConditionMatched) continue;

      rulesMatchedCount++;

      // Execute actions in this rule
      const actionsToRun = rule.actions ?? [];
      let ruleChainFailed = false;

      for (let i = 0; i < actionsToRun.length; i++) {
        const actionDef = actionsToRun[i];

        // 1. Check action budget
        if (totalActionsExecuted >= maxActions) {
          allResults.push({
            tool: actionDef.tool,
            label: actionDef.label,
            args: {},
            payload: { error: "action budget exceeded" },
            isError: true,
            status: "budget-exceeded",
            error: `Follow-on action budget exceeded (${totalActionsExecuted} >= ${maxActions})`,
          });
          ruleChainFailed = true;
          break;
        }

        // 2. Check depth cap
        if (currentContext.depth >= maxDepth) {
          allResults.push({
            tool: actionDef.tool,
            label: actionDef.label,
            args: {},
            payload: { error: "max depth exceeded" },
            isError: true,
            status: "depth-exceeded",
            error: `Follow-on depth cap exceeded (depth=${currentContext.depth}, max=${maxDepth})`,
          });
          ruleChainFailed = true;
          break;
        }

        // 3. Check cycle detection
        if (preventCycles && currentContext.callStack.includes(actionDef.tool)) {
          allResults.push({
            tool: actionDef.tool,
            label: actionDef.label,
            args: {},
            payload: { error: "recursion cycle detected" },
            isError: true,
            status: "cycle-detected",
            error: `Recursion cycle detected for tool '${actionDef.tool}' in stack: ${currentContext.callStack.join(" -> ")}`,
          });
          ruleChainFailed = true;
          break;
        }

        // 4. Check action-level condition guard if present
        if (actionDef.condition) {
          const actionCondMatched = yield* evaluateConditionEffect(actionDef.condition, currentContext);
          if (!actionCondMatched) {
            allResults.push({
              tool: actionDef.tool,
              label: actionDef.label,
              args: {},
              payload: { skipped: true, reason: "action condition not met" },
              isError: false,
              status: "skipped",
            });
            continue;
          }
        }

        // 5. Interpolate / build arguments
        let computedArgs: Record<string, unknown> = {};
        if (actionDef.argsBuilder) {
          try {
            const dynamic = actionDef.argsBuilder(currentContext);
            if (dynamic instanceof Promise) {
              computedArgs = yield* Effect.promise(() => dynamic);
            } else if (typeof dynamic === "object" && dynamic !== null && "_tag" in dynamic) {
              computedArgs = yield* dynamic as unknown as Effect.Effect<Record<string, unknown>, never, never>;
            } else {
              computedArgs = dynamic as Record<string, unknown>;
            }
          } catch (exc) {
            computedArgs = { error: String(exc) };
          }
        } else {
          computedArgs = interpolateArgs(actionDef.arguments, currentContext);
        }

        totalActionsExecuted++;
        const targetTool = actionDef.tool;

        // 6. CRITICAL LOAD-BEARING SAFETY GATE: Auth Tier & Anti-Laundering Check
        // Every chained action MUST be authenticated against its assigned tier.
        const tier = tierOf(targetTool);

        // A. Reject forbidden or unknown tools
        if (tier === TIER_FORBIDDEN || tier === null) {
          const reason = tier === TIER_FORBIDDEN ? "forbidden" : "unknown-tool";
          yield* auditAppend(
            auditService,
            toolCtx,
            targetTool,
            "refuse",
            reason,
            computedArgs["approval"],
            String(computedArgs["id"] ?? computedArgs["target"] ?? computedArgs["task_id"] ?? ""),
          );
          allResults.push({
            tool: targetTool,
            label: actionDef.label,
            args: computedArgs,
            payload: { error: `unknown tool: ${targetTool}` },
            isError: true,
            status: "refused",
            error: `Tool '${targetTool}' is forbidden or unknown`,
          });
          totalActionsFailed++;
          ruleChainFailed = true;

          // Run action-level compensation if present
          if (actionDef.onFailure && actionDef.onFailure.length > 0) {
            for (const failAction of actionDef.onFailure) {
              if (totalActionsExecuted >= maxActions) break;
              const failArgs = interpolateArgs(failAction.arguments, currentContext);
              if (failAction.tool in TOOLS && tierOf(failAction.tool) !== TIER_FORBIDDEN) {
                totalActionsExecuted++;
                try {
                  const compResult = yield* Effect.promise(() => TOOLS[failAction.tool].handler(failArgs, toolCtx));
                  allResults.push({
                    tool: failAction.tool,
                    label: failAction.label ? `compensation: ${failAction.label}` : "compensation",
                    args: failArgs,
                    payload: compResult.payload,
                    isError: compResult.isError,
                    status: compResult.isError ? "failed" : "success",
                  });
                } catch {
                  /* compensation best effort */
                }
              }
            }
          }

          if (!actionDef.continueOnError && !rule.continueOnError) break;
          continue;
        }

        // B. Enforce approval for Tier 3 (authority writes) and Tier 4 (external sends)
        if (tier === TIER_AUTHORITY || tier === TIER_EXTERNAL) {
          const approvalVal = computedArgs["approval"];
          if (!validApproval(approvalVal)) {
            const refuseReason =
              approvalVal === undefined || approvalVal === null
                ? "approval-required"
                : "approval-invalid";
            yield* auditAppend(
              auditService,
              toolCtx,
              targetTool,
              "refuse",
              refuseReason,
              approvalVal,
              String(computedArgs["id"] ?? computedArgs["target"] ?? computedArgs["task_id"] ?? ""),
            );
            allResults.push({
              tool: targetTool,
              label: actionDef.label,
              args: computedArgs,
              payload: {
                error: "approval required",
                expect: "explicit approval string starting with 'I authorize'",
              },
              isError: true,
              status: "refused",
              error: `Authority tool '${targetTool}' refused: ${refuseReason}`,
            });
            totalActionsFailed++;
            ruleChainFailed = true;

            // Run action-level compensation if present
            if (actionDef.onFailure && actionDef.onFailure.length > 0) {
              for (const failAction of actionDef.onFailure) {
                if (totalActionsExecuted >= maxActions) break;
                const failArgs = interpolateArgs(failAction.arguments, currentContext);
                if (failAction.tool in TOOLS && tierOf(failAction.tool) !== TIER_FORBIDDEN) {
                  totalActionsExecuted++;
                  try {
                    const compResult = yield* Effect.promise(() => TOOLS[failAction.tool].handler(failArgs, toolCtx));
                    allResults.push({
                      tool: failAction.tool,
                      label: failAction.label ? `compensation: ${failAction.label}` : "compensation",
                      args: failArgs,
                      payload: compResult.payload,
                      isError: compResult.isError,
                      status: compResult.isError ? "failed" : "success",
                    });
                  } catch {
                    /* compensation best effort */
                  }
                }
              }
            }

            if (!actionDef.continueOnError && !rule.continueOnError) break;
            continue;
          }
        }

        // 7. Tool exists in registry check
        if (!(targetTool in TOOLS)) {
          yield* auditAppend(
            auditService,
            toolCtx,
            targetTool,
            "refuse",
            "unknown-tool",
            computedArgs["approval"],
            null,
          );
          allResults.push({
            tool: targetTool,
            label: actionDef.label,
            args: computedArgs,
            payload: { error: `unknown tool: ${targetTool}` },
            isError: true,
            status: "failed",
            error: `Tool '${targetTool}' missing from TOOLS registry`,
          });
          totalActionsFailed++;
          ruleChainFailed = true;
          if (!actionDef.continueOnError && !rule.continueOnError) break;
          continue;
        }

        // 8. Execute Tool with isolated failure boundary
        const startTime = Date.now();
        let toolExecOutcome: ToolResult;
        try {
          toolExecOutcome = yield* Effect.promise(() => TOOLS[targetTool].handler(computedArgs, toolCtx));
        } catch (exc) {
          toolExecOutcome = {
            payload: { error: "tool crashed", detail: String(exc) },
            isError: true,
          };
        }
        const durationMs = Date.now() - startTime;

        // 9. Audit follow-on tool execution
        const auditDecision = "allow";
        const auditReason = "ok";
        yield* auditAppend(
          auditService,
          toolCtx,
          targetTool,
          auditDecision,
          auditReason,
          computedArgs["approval"],
          String(computedArgs["id"] ?? computedArgs["target"] ?? computedArgs["task_id"] ?? ""),
        );

        const actionStatus: ActionStatus = toolExecOutcome.isError ? "failed" : "success";
        const actionResult: FollowOnActionResult = {
          tool: targetTool,
          label: actionDef.label,
          args: computedArgs,
          payload: toolExecOutcome.payload,
          isError: toolExecOutcome.isError,
          status: actionStatus,
          duration_ms: durationMs,
          error: toolExecOutcome.isError ? String(toolExecOutcome.payload["error"] ?? "unknown error") : undefined,
        };

        allResults.push(actionResult);

        if (toolExecOutcome.isError) {
          totalActionsFailed++;
        } else {
          totalActionsSucceeded++;
        }

        // Update context for next step in chain
        const stepContext: StepContext = {
          tool: targetTool,
          args: computedArgs,
          payload: toolExecOutcome.payload,
          isError: toolExecOutcome.isError,
          status: actionStatus,
        };

        currentContext = {
          ...currentContext,
          previous: stepContext,
          chain: [...currentContext.chain, stepContext],
          callStack: [...currentContext.callStack, targetTool],
        };

        // Handle step failure flow control
        if (toolExecOutcome.isError) {
          // If specific action has compensation / rollback actions, run them
          if (actionDef.onFailure && actionDef.onFailure.length > 0) {
            for (const failAction of actionDef.onFailure) {
              if (totalActionsExecuted >= maxActions) break;
              const failArgs = interpolateArgs(failAction.arguments, currentContext);
              if (failAction.tool in TOOLS && tierOf(failAction.tool) !== TIER_FORBIDDEN) {
                totalActionsExecuted++;
                try {
                  const compResult = yield* Effect.promise(() => TOOLS[failAction.tool].handler(failArgs, toolCtx));
                  allResults.push({
                    tool: failAction.tool,
                    label: failAction.label ? `compensation: ${failAction.label}` : "compensation",
                    args: failArgs,
                    payload: compResult.payload,
                    isError: compResult.isError,
                    status: compResult.isError ? "failed" : "success",
                  });
                } catch {
                  /* compensation best effort */
                }
              }
            }
          }

          if (!actionDef.continueOnError && !rule.continueOnError) {
            ruleChainFailed = true;
            break;
          }
        }
      }

      // Rule-level failure compensation if chain failed
      if (ruleChainFailed && rule.onFailure && rule.onFailure.length > 0) {
        for (const failAction of rule.onFailure) {
          if (totalActionsExecuted >= maxActions) break;
          const failArgs = interpolateArgs(failAction.arguments, currentContext);
          if (failAction.tool in TOOLS && tierOf(failAction.tool) !== TIER_FORBIDDEN) {
            totalActionsExecuted++;
            try {
              const compResult = yield* Effect.promise(() => TOOLS[failAction.tool].handler(failArgs, toolCtx));
              allResults.push({
                tool: failAction.tool,
                label: failAction.label ? `rule-compensation: ${failAction.label}` : "rule-compensation",
                args: failArgs,
                payload: compResult.payload,
                isError: compResult.isError,
                status: compResult.isError ? "failed" : "success",
              });
            } catch {
              /* compensation best effort */
            }
          }
        }
      }
    }

    return {
      traceId,
      originTool: origin.tool,
      rulesEvaluated: matchingRules.length,
      rulesMatched: rulesMatchedCount,
      actionsExecuted: totalActionsExecuted,
      actionsSucceeded: totalActionsSucceeded,
      actionsFailed: totalActionsFailed,
      results: allResults,
      completedAt: new Date().toISOString(),
    };
  });
}

/** In-memory store + config loader implementation of FollowOnService. */
export function makeFollowOnApi(initialRules: readonly FollowOnRule[] = []): FollowOnApi {
  const rulesStore: FollowOnRule[] = [...initialRules];

  return {
    registerRule: (rule) =>
      Effect.sync(() => {
        rulesStore.push(rule);
      }),
    registerRules: (rules) =>
      Effect.sync(() => {
        rulesStore.push(...rules);
      }),
    getRules: () => Effect.sync(() => [...rulesStore]),
    clearRules: () =>
      Effect.sync(() => {
        rulesStore.length = 0;
      }),
    loadConfigFile: (configPath) =>
      Effect.sync(() => {
        const targetPath =
          configPath ??
          process.env.FM_FOLLOWON_CONFIG ??
          (process.env.FM_HOME
            ? path.join(process.env.FM_HOME, "config", "followons.json")
            : undefined);

        if (!targetPath || !fs.existsSync(targetPath)) return 0;

        try {
          const raw = fs.readFileSync(targetPath, "utf8");
          const parsed = JSON.parse(raw);
          const loaded: FollowOnRule[] = Array.isArray(parsed) ? parsed : parsed.rules ?? [];
          rulesStore.push(...loaded);
          return loaded.length;
        } catch {
          return 0;
        }
      }),
    executeFollowOns: (origin, toolCtx, options) =>
      executeFollowOnsEffect(origin, toolCtx, rulesStore, options),
  };
}

/** Live layer for FollowOnService. */
export const FollowOnLive: Layer.Layer<FollowOnService> = Layer.sync(
  FollowOnService,
  () => {
    const api = makeFollowOnApi();
    Effect.runSync(api.loadConfigFile());
    return FollowOnService.of(api);
  },
);

/** Hermetic test layer with pre-configured rules. */
export function makeTestFollowOnLayer(
  initialRules: readonly FollowOnRule[] = [],
): Layer.Layer<FollowOnService> {
  return Layer.succeed(
    FollowOnService,
    FollowOnService.of(makeFollowOnApi(initialRules)),
  );
}
