/**
 * Triggers, conditions, rules, context + result types. (slice 19 of the followon.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/followon.ts. Exported there, re-exported via
 * followon.ts so the `./followon.js` public surface is unchanged.
 */
import { Effect } from "effect";

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

