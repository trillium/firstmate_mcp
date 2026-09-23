/**
 * Error taxonomy + depth/budget constants. (slice 19 of the followon.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/followon.ts. Exported there, re-exported via
 * followon.ts so the `./followon.js` public surface is unchanged.
 */
import { Data } from "effect";

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

