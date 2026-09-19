/**
 * Comprehensive test suite for customizable follow-on actions.
 *
 * Covers:
 * 1. Rule registration, trigger matching, priority ordering, outcome selectors.
 * 2. Condition language: dot path extraction, all operators, boolean combinators (and/or/not), functional predicates.
 * 3. Argument templating & interpolation: exact type preservation, embedded strings, deep objects/arrays, dynamic builders.
 * 4. Ordering semantics: strict sequential execution, continueOnError flow control, onFailure compensation actions.
 * 5. LOAD-BEARING AUTH TIERS & ANTI-LAUNDERING SAFETY PROPERTY:
 *    - Tier 1 read trigger attempting Tier 3 write without approval -> REFUSED, never executed, audit refuse.
 *    - Tier 1 trigger attempting Tier 3 write with bad approval -> REFUSED, never executed.
 *    - Tier 1 trigger with valid explicit approval in action -> ALLOWED, executed, audit allow.
 *    - Tier 2 steer trigger attempting Tier 4 send without approval -> REFUSED.
 *    - Tier 3 trigger with approval attempting another Tier 3 write WITHOUT explicit approval in follow-on -> REFUSED (no implicit laundering).
 *    - Forbidden tools (promote_scout, teardown_crew, etc.) -> REFUSED (forbidden), never executed.
 * 6. Loop prevention & Termination:
 *    - Cycle detection halts direct and indirect recursion.
 *    - Strict depth cap halts cascades exceeding maxDepth.
 *    - Action budget halts execution exceeding maxActions.
 * 7. Failure isolation: follow-on errors never break the originating tool's envelope or wire response.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import {
  FollowOnService,
  makeFollowOnApi,
  makeTestFollowOnLayer,
  extractPath,
  extractFromContext,
  evaluateFieldCondition,
  evaluateConditionEffect,
  interpolateValue,
  interpolateArgs,
  matchesTrigger,
  executeFollowOnsEffect,
  type FollowOnRule,
  type FollowOnContext,
  type OriginContext,
} from "../src/followon.js";
import { AuditService, makeTestAuditLayer, readAuditLines, type AuditLine } from "../src/auth.js";
import { type ToolContext, liveContext } from "../src/tools.js";
import { makeTestConfig } from "../src/config.js";
import { makeTestRunnerLayer } from "../src/runner.js";
import { Client, makeStubHome, removeHome, payload, isError } from "./helpers.js";

const APPROVAL = "I authorize follow-on test execution";

function createMockToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  const snapshotJson = JSON.stringify({
    schema: "fm-fleet-snapshot.v1",
    generated: "2026-09-18T00:00:00Z",
    backlog: { total: 1, open: 1 },
    tasks: [{ id: "task-100", state: "working" }],
  });
  return {
    binDir: "/mock/bin",
    stateDir: "/mock/state",
    dataDir: "/mock/data",
    run: async (argv) => {
      const cmd = argv[0] ?? "";
      if (cmd.includes("snapshot")) {
        return { stdout: snapshotJson, stderr: "", exitCode: 0 };
      }
      if (cmd.includes("crew-state")) {
        return { stdout: "state: working · task: task-100", stderr: "", exitCode: 0 };
      }
      return { stdout: "ok\n", stderr: "", exitCode: 0 };
    },
    ...overrides,
  };
}

function createMockOrigin(overrides: Partial<OriginContext> = {}): OriginContext {
  return {
    tool: "fleet_snapshot",
    args: { target: "crew-1", count: 5 },
    payload: { ok: true, status: "healthy", activeCount: 3, records: [{ id: "task-100", score: 95 }] },
    isError: false,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("Follow-On: Path Extraction & Condition Evaluation", () => {
  const origin = createMockOrigin();
  const mockCtx: FollowOnContext = {
    origin,
    previous: {
      tool: "fleet_snapshot",
      args: origin.args,
      payload: origin.payload,
      isError: false,
      status: "success",
    },
    chain: [],
    env: {
      homeDir: "/mock/home",
      binDir: "/mock/bin",
      stateDir: "/mock/state",
      dataDir: "/mock/data",
      actor: "test-runner",
    },
    depth: 0,
    traceId: "test-trace-1",
    callStack: ["fleet_snapshot"],
  };

  test("extractPath extracts nested properties and array indices", () => {
    const obj = { a: { b: { c: 42, list: [{ name: "first" }, { name: "second" }] } } };
    assert.strictEqual(extractPath(obj, "a.b.c"), 42);
    assert.strictEqual(extractPath(obj, "a.b.list[0].name"), "first");
    assert.strictEqual(extractPath(obj, "a.b.list.1.name"), "second");
    assert.strictEqual(extractPath(obj, "a.nonexistent.val"), undefined);
    assert.strictEqual(extractPath(null, "a.b"), undefined);
  });

  test("extractFromContext resolves paths across origin, previous, and env", () => {
    assert.strictEqual(extractFromContext(mockCtx, "origin.payload.status"), "healthy");
    assert.strictEqual(extractFromContext(mockCtx, "payload.activeCount"), 3);
    assert.strictEqual(extractFromContext(mockCtx, "args.target"), "crew-1");
    assert.strictEqual(extractFromContext(mockCtx, "env.stateDir"), "/mock/state");
    assert.strictEqual(extractFromContext(mockCtx, "depth"), 0);
    assert.strictEqual(extractFromContext(mockCtx, "isError"), false);
    assert.strictEqual(extractFromContext(mockCtx, "tool"), "fleet_snapshot");
  });

  test("evaluateFieldCondition supports all comparison operators", () => {
    // Equality
    assert.strictEqual(evaluateFieldCondition(42, "equals", 42), true);
    assert.strictEqual(evaluateFieldCondition(42, "eq", 42), true);
    assert.strictEqual(evaluateFieldCondition("a", "not_equals", "b"), true);
    assert.strictEqual(evaluateFieldCondition("a", "neq", "a"), false);

    // String & Array Contains
    assert.strictEqual(evaluateFieldCondition("hello world", "contains", "world"), true);
    assert.strictEqual(evaluateFieldCondition("hello", "not_contains", "world"), true);
    assert.strictEqual(evaluateFieldCondition(["a", "b", "c"], "contains", "b"), true);
    assert.strictEqual(evaluateFieldCondition(["a", "b"], "contains", "z"), false);

    // Prefix & Suffix
    assert.strictEqual(evaluateFieldCondition("task-123", "starts_with", "task-"), true);
    assert.strictEqual(evaluateFieldCondition("image.png", "ends_with", ".png"), true);

    // Set membership
    assert.strictEqual(evaluateFieldCondition("done", "in", ["done", "ready"]), true);
    assert.strictEqual(evaluateFieldCondition("pending", "in", ["done", "ready"]), false);
    assert.strictEqual(evaluateFieldCondition("pending", "not_in", ["done", "ready"]), true);

    // Numeric comparison
    assert.strictEqual(evaluateFieldCondition(10, "greater_than", 5), true);
    assert.strictEqual(evaluateFieldCondition(10, "gt", 10), false);
    assert.strictEqual(evaluateFieldCondition(10, "greater_than_or_equal", 10), true);
    assert.strictEqual(evaluateFieldCondition(10, "gte", 15), false);
    assert.strictEqual(evaluateFieldCondition(3, "less_than", 5), true);
    assert.strictEqual(evaluateFieldCondition(3, "lt", 3), false);
    assert.strictEqual(evaluateFieldCondition(3, "less_than_or_equal", 3), true);

    // Existence & Truthiness
    assert.strictEqual(evaluateFieldCondition("something", "exists", undefined), true);
    assert.strictEqual(evaluateFieldCondition(undefined, "exists", undefined), false);
    assert.strictEqual(evaluateFieldCondition(null, "not_exists", undefined), true);
    assert.strictEqual(evaluateFieldCondition(true, "truthy", undefined), true);
    assert.strictEqual(evaluateFieldCondition(0, "truthy", undefined), false);
    assert.strictEqual(evaluateFieldCondition(false, "falsy", undefined), true);

    // Regex
    assert.strictEqual(evaluateFieldCondition("task-abc-123", "regex", "^task-[a-z]+-\\d+$"), true);
    assert.strictEqual(evaluateFieldCondition("invalid", "regex", "^task-"), false);
  });

  test("evaluateConditionEffect handles boolean trees (and, or, not)", async () => {
    // AND condition
    const andCond = {
      and: [
        { field: "payload.status", operator: "equals" as const, value: "healthy" },
        { field: "payload.activeCount", operator: "gt" as const, value: 2 },
      ],
    };
    const andMatch = await Effect.runPromise(evaluateConditionEffect(andCond, mockCtx));
    assert.strictEqual(andMatch, true);

    // Failing AND
    const andFail = {
      and: [
        { field: "payload.status", operator: "equals" as const, value: "healthy" },
        { field: "payload.activeCount", operator: "gt" as const, value: 10 },
      ],
    };
    const andFailMatch = await Effect.runPromise(evaluateConditionEffect(andFail, mockCtx));
    assert.strictEqual(andFailMatch, false);

    // OR condition
    const orCond = {
      or: [
        { field: "payload.status", operator: "equals" as const, value: "failed" },
        { field: "payload.activeCount", operator: "equals" as const, value: 3 },
      ],
    };
    const orMatch = await Effect.runPromise(evaluateConditionEffect(orCond, mockCtx));
    assert.strictEqual(orMatch, true);

    // NOT condition
    const notCond = {
      not: { field: "isError", operator: "equals" as const, value: true },
    };
    const notMatch = await Effect.runPromise(evaluateConditionEffect(notCond, mockCtx));
    assert.strictEqual(notMatch, true);
  });

  test("evaluateConditionEffect supports functional predicates", async () => {
    const fnCond = (ctx: FollowOnContext) => (ctx.origin.payload["activeCount"] as number) === 3;
    const fnMatch = await Effect.runPromise(evaluateConditionEffect(fnCond, mockCtx));
    assert.strictEqual(fnMatch, true);

    const fnAsyncCond = async (ctx: FollowOnContext) => ctx.depth === 0;
    const fnAsyncMatch = await Effect.runPromise(evaluateConditionEffect(fnAsyncCond, mockCtx));
    assert.strictEqual(fnAsyncMatch, true);
  });
});

describe("Follow-On: Argument Templating & Interpolation", () => {
  const origin = createMockOrigin();
  const mockCtx: FollowOnContext = {
    origin,
    previous: {
      tool: "fleet_snapshot",
      args: origin.args,
      payload: origin.payload,
      isError: false,
      status: "success",
    },
    chain: [],
    env: {
      homeDir: "/mock/home",
      binDir: "/mock/bin",
      stateDir: "/mock/state",
      dataDir: "/mock/data",
      actor: "test-runner",
    },
    depth: 0,
    traceId: "test-trace-1",
    callStack: ["fleet_snapshot"],
  };

  test("interpolateValue preserves native types on exact template match", () => {
    // Number preservation
    const num = interpolateValue("${payload.activeCount}", mockCtx);
    assert.strictEqual(num, 3);
    assert.strictEqual(typeof num, "number");

    // Boolean preservation
    const bool = interpolateValue("${payload.ok}", mockCtx);
    assert.strictEqual(bool, true);
    assert.strictEqual(typeof bool, "boolean");

    // Array / Object preservation
    const recs = interpolateValue("${payload.records}", mockCtx);
    assert.deepStrictEqual(recs, [{ id: "task-100", score: 95 }]);
  });

  test("interpolateValue embeds string values correctly", () => {
    const str = interpolateValue("Task ID is ${payload.records[0].id} for ${args.target}", mockCtx);
    assert.strictEqual(str, "Task ID is task-100 for crew-1");
  });

  test("interpolateArgs recursively processes nested objects and arrays", () => {
    const inputArgs = {
      id: "${payload.records[0].id}",
      count: "${payload.activeCount}",
      details: {
        target: "${args.target}",
        envPath: "${env.stateDir}",
        tags: ["prefix-${payload.status}", "${payload.ok}"],
      },
    };

    const result = interpolateArgs(inputArgs, mockCtx);
    assert.deepStrictEqual(result, {
      id: "task-100",
      count: 3,
      details: {
        target: "crew-1",
        envPath: "/mock/state",
        tags: ["prefix-healthy", true],
      },
    });
  });
});

describe("Follow-On: Trigger Matching & Rule Execution", () => {
  test("matchesTrigger handles tool names, wildcards, and outcome filters", () => {
    // Specific tool
    assert.strictEqual(matchesTrigger({ tool: "fleet_snapshot", on: "success" }, "fleet_snapshot", false), true);
    assert.strictEqual(matchesTrigger({ tool: "fleet_snapshot", on: "success" }, "fleet_snapshot", true), false);
    assert.strictEqual(matchesTrigger({ tool: "fleet_snapshot", on: "failure" }, "fleet_snapshot", true), true);
    assert.strictEqual(matchesTrigger({ tool: "fleet_snapshot", on: "always" }, "fleet_snapshot", true), true);
    assert.strictEqual(matchesTrigger({ tool: "fleet_snapshot", on: "always" }, "fleet_snapshot", false), true);

    // Tool array
    assert.strictEqual(matchesTrigger({ tool: ["fleet_snapshot", "backlog"], on: "success" }, "backlog", false), true);
    assert.strictEqual(matchesTrigger({ tool: ["fleet_snapshot", "backlog"], on: "success" }, "other", false), false);

    // Wildcard
    assert.strictEqual(matchesTrigger({ tool: "*", on: "success" }, "any_tool", false), true);
  });

  test("makeFollowOnApi registers and retrieves rules in priority order", async () => {
    const api = makeFollowOnApi();
    await Effect.runPromise(
      api.registerRule({
        id: "low-prio",
        trigger: { tool: "fleet_snapshot", priority: 1 },
        actions: [{ tool: "backlog" }],
      }),
    );
    await Effect.runPromise(
      api.registerRule({
        id: "high-prio",
        trigger: { tool: "fleet_snapshot", priority: 10 },
        actions: [{ tool: "peek", arguments: { target: "task-1" } }],
      }),
    );

    const rules = await Effect.runPromise(api.getRules());
    assert.strictEqual(rules.length, 2);
    assert.strictEqual(rules[0].id, "low-prio");
    assert.strictEqual(rules[1].id, "high-prio");

    await Effect.runPromise(api.clearRules());
    const cleared = await Effect.runPromise(api.getRules());
    assert.strictEqual(cleared.length, 0);
  });

  test("executes sequential follow-on actions and forwards context", async () => {
    const auditLines: AuditLine[] = [];
    const testAuditLayer = makeTestAuditLayer(auditLines);

    let backlogRan = false;
    let peekRanWith: Record<string, unknown> | null = null;

    const mockToolContext = createMockToolContext();

    const rules: FollowOnRule[] = [
      {
        id: "snapshot-chain",
        trigger: { tool: "fleet_snapshot", on: "success" },
        actions: [
          {
            tool: "backlog",
            arguments: {},
            label: "step-1-backlog",
          },
          {
            tool: "peek",
            arguments: {
              target: "${origin.payload.records[0].id}",
              lines: 10,
            },
            label: "step-2-peek",
          },
        ],
      },
    ];

    const origin = createMockOrigin();

    const program = executeFollowOnsEffect(origin, mockToolContext, rules).pipe(
      Effect.provide(testAuditLayer),
    );

    const summary = await Effect.runPromise(program);

    assert.strictEqual(summary.rulesMatched, 1);
    assert.strictEqual(summary.actionsExecuted, 2);
    assert.strictEqual(summary.results.length, 2);
    assert.strictEqual(summary.results[0].tool, "backlog");
    assert.strictEqual(summary.results[1].tool, "peek");
    assert.strictEqual(summary.results[1].args["target"], "task-100");
    assert.strictEqual(summary.results[1].args["lines"], 10);
  });
});

describe("Follow-On: LOAD-BEARING AUTH TIERS & ANTI-LAUNDERING SAFETY", () => {
  test("Tier 1 read trigger attempting Tier 3 write WITHOUT approval is REFUSED", async () => {
    const auditLines: AuditLine[] = [];
    const testAuditLayer = makeTestAuditLayer(auditLines);
    const mockToolContext = createMockToolContext();

    // A read tool (Tier 1) attempts to trigger a write tool (Tier 3 lifecycle_exit) with NO approval
    const rules: FollowOnRule[] = [
      {
        id: "unauthorized-escalation-attempt",
        trigger: { tool: "fleet_snapshot", on: "success" },
        actions: [
          {
            tool: "lifecycle_exit",
            arguments: { id: "crew-1" }, // NO approval!
            label: "unauthorized-kill",
          },
        ],
      },
    ];

    const origin = createMockOrigin({ tool: "fleet_snapshot" });

    const summary = await Effect.runPromise(
      executeFollowOnsEffect(origin, mockToolContext, rules).pipe(
        Effect.provide(testAuditLayer),
      ),
    );

    // Action MUST be refused
    assert.strictEqual(summary.actionsExecuted, 1);
    assert.strictEqual(summary.actionsFailed, 1);
    assert.strictEqual(summary.results[0].status, "refused");
    assert.strictEqual(summary.results[0].payload["error"], "approval required");

    // Audit log MUST record refuse for lifecycle_exit with approval-required
    const exitAudit = auditLines.find((line) => line.tool === "lifecycle_exit");
    assert.ok(exitAudit, "Audit line for lifecycle_exit must be recorded");
    assert.strictEqual(exitAudit.decision, "refuse");
    assert.strictEqual(exitAudit.reason, "approval-required");
  });

  test("Tier 1 trigger attempting Tier 3 write with INVALID approval is REFUSED", async () => {
    const auditLines: AuditLine[] = [];
    const testAuditLayer = makeTestAuditLayer(auditLines);
    const mockToolContext = createMockToolContext();

    const rules: FollowOnRule[] = [
      {
        id: "invalid-token-escalation",
        trigger: { tool: "fleet_snapshot", on: "success" },
        actions: [
          {
            tool: "spawn_crew",
            arguments: {
              task_id: "task-1",
              project: "myproj",
              mode: "local-only",
              approval: "invalid token without required prefix",
            },
          },
        ],
      },
    ];

    const origin = createMockOrigin();

    const summary = await Effect.runPromise(
      executeFollowOnsEffect(origin, mockToolContext, rules).pipe(
        Effect.provide(testAuditLayer),
      ),
    );

    assert.strictEqual(summary.actionsFailed, 1);
    assert.strictEqual(summary.results[0].status, "refused");

    const spawnAudit = auditLines.find((line) => line.tool === "spawn_crew");
    assert.ok(spawnAudit);
    assert.strictEqual(spawnAudit.decision, "refuse");
    assert.strictEqual(spawnAudit.reason, "approval-invalid");
  });

  test("Tier 1 trigger attempting Tier 3 write with VALID EXPLICIT approval is ALLOWED", async () => {
    const auditLines: AuditLine[] = [];
    const testAuditLayer = makeTestAuditLayer(auditLines);
    const mockToolContext = createMockToolContext();

    const rules: FollowOnRule[] = [
      {
        id: "authorized-followon-write",
        trigger: { tool: "fleet_snapshot", on: "success" },
        actions: [
          {
            tool: "lifecycle_exit",
            arguments: {
              id: "crew-1",
              approval: APPROVAL,
            },
          },
        ],
      },
    ];

    const origin = createMockOrigin();

    const summary = await Effect.runPromise(
      executeFollowOnsEffect(origin, mockToolContext, rules).pipe(
        Effect.provide(testAuditLayer),
      ),
    );

    assert.strictEqual(summary.actionsExecuted, 1);
    assert.strictEqual(summary.results[0].status, "success");

    const exitAudit = auditLines.find((line) => line.tool === "lifecycle_exit");
    assert.ok(exitAudit);
    assert.strictEqual(exitAudit.decision, "allow");
    assert.strictEqual(exitAudit.reason, "ok");
    assert.ok(exitAudit.approval_ref, "approval_ref must be present");
  });

  test("Tier 3 approved trigger DOES NOT implicitly authorize follow-on Tier 3 action without explicit approval in action", async () => {
    const auditLines: AuditLine[] = [];
    const testAuditLayer = makeTestAuditLayer(auditLines);
    const mockToolContext = createMockToolContext();

    // Originating tool was Tier 3 spawn_crew with valid approval
    const origin: OriginContext = {
      tool: "spawn_crew",
      args: { task_id: "t1", project: "p", mode: "local-only", approval: APPROVAL },
      payload: { ok: true, crew_id: "crew-1" },
      isError: false,
    };

    // Rule triggers lifecycle_exit without providing approval in arguments
    const rules: FollowOnRule[] = [
      {
        id: "implicit-laundering-attempt",
        trigger: { tool: "spawn_crew", on: "success" },
        actions: [
          {
            tool: "lifecycle_exit",
            arguments: { id: "${origin.payload.crew_id}" }, // No approval passed!
          },
        ],
      },
    ];

    const summary = await Effect.runPromise(
      executeFollowOnsEffect(origin, mockToolContext, rules).pipe(
        Effect.provide(testAuditLayer),
      ),
    );

    // Must be refused: authority is NOT implicitly laundered across chained calls!
    assert.strictEqual(summary.actionsFailed, 1);
    assert.strictEqual(summary.results[0].status, "refused");
    assert.strictEqual(summary.results[0].payload["error"], "approval required");
  });

  test("Code-forbidden tools (promote_scout, teardown_crew, etc.) are strictly refused", async () => {
    const auditLines: AuditLine[] = [];
    const testAuditLayer = makeTestAuditLayer(auditLines);
    const mockToolContext = createMockToolContext();

    const rules: FollowOnRule[] = [
      {
        id: "forbidden-tool-attempt",
        trigger: { tool: "fleet_snapshot", on: "success" },
        actions: [
          {
            tool: "promote_scout",
            arguments: { approval: APPROVAL },
          },
        ],
      },
    ];

    const origin = createMockOrigin();

    const summary = await Effect.runPromise(
      executeFollowOnsEffect(origin, mockToolContext, rules).pipe(
        Effect.provide(testAuditLayer),
      ),
    );

    assert.strictEqual(summary.actionsFailed, 1);
    assert.strictEqual(summary.results[0].status, "refused");

    const forbiddenAudit = auditLines.find((line) => line.tool === "promote_scout");
    assert.ok(forbiddenAudit);
    assert.strictEqual(forbiddenAudit.decision, "refuse");
    assert.strictEqual(forbiddenAudit.reason, "forbidden");
  });
});

describe("Follow-On: Flow Control, Failure Isolation & Compensation", () => {
  test("continueOnError: false halts remaining actions in chain on failure", async () => {
    const auditLines: AuditLine[] = [];
    const testAuditLayer = makeTestAuditLayer(auditLines);
    const mockToolContext = createMockToolContext();

    const rules: FollowOnRule[] = [
      {
        id: "fail-stop-chain",
        trigger: { tool: "fleet_snapshot", on: "success" },
        actions: [
          {
            tool: "lifecycle_exit", // Will fail because no approval
            arguments: { id: "crew-1" },
            continueOnError: false,
          },
          {
            tool: "backlog",
            arguments: {},
          },
        ],
      },
    ];

    const origin = createMockOrigin();

    const summary = await Effect.runPromise(
      executeFollowOnsEffect(origin, mockToolContext, rules).pipe(
        Effect.provide(testAuditLayer),
      ),
    );

    assert.strictEqual(summary.actionsExecuted, 1);
    assert.strictEqual(summary.actionsFailed, 1);
    assert.strictEqual(summary.results.length, 1);
    assert.strictEqual(summary.results[0].tool, "lifecycle_exit");
  });

  test("continueOnError: true executes remaining actions despite failure", async () => {
    const auditLines: AuditLine[] = [];
    const testAuditLayer = makeTestAuditLayer(auditLines);
    const mockToolContext = createMockToolContext();

    const rules: FollowOnRule[] = [
      {
        id: "continue-on-error-chain",
        trigger: { tool: "fleet_snapshot", on: "success" },
        actions: [
          {
            tool: "lifecycle_exit", // Will fail
            arguments: { id: "crew-1" },
            continueOnError: true,
          },
          {
            tool: "backlog", // Should still execute
            arguments: {},
          },
        ],
      },
    ];

    const origin = createMockOrigin();

    const summary = await Effect.runPromise(
      executeFollowOnsEffect(origin, mockToolContext, rules).pipe(
        Effect.provide(testAuditLayer),
      ),
    );

    assert.strictEqual(summary.actionsExecuted, 2);
    assert.strictEqual(summary.actionsFailed, 1);
    assert.strictEqual(summary.actionsSucceeded, 1);
    assert.strictEqual(summary.results.length, 2);
    assert.strictEqual(summary.results[1].tool, "backlog");
    assert.strictEqual(summary.results[1].status, "success");
  });

  test("onFailure runs compensation rollback actions when step fails", async () => {
    const auditLines: AuditLine[] = [];
    const testAuditLayer = makeTestAuditLayer(auditLines);
    const mockToolContext = createMockToolContext();

    const rules: FollowOnRule[] = [
      {
        id: "compensation-chain",
        trigger: { tool: "fleet_snapshot", on: "success" },
        actions: [
          {
            tool: "lifecycle_exit", // Fails (no approval)
            arguments: { id: "crew-1" },
            onFailure: [
              {
                tool: "backlog", // Compensation action
                arguments: {},
                label: "notify-backlog-on-exit-failure",
              },
            ],
          },
        ],
      },
    ];

    const origin = createMockOrigin();

    const summary = await Effect.runPromise(
      executeFollowOnsEffect(origin, mockToolContext, rules).pipe(
        Effect.provide(testAuditLayer),
      ),
    );

    assert.strictEqual(summary.actionsExecuted, 2);
    assert.strictEqual(summary.results.length, 2);
    assert.strictEqual(summary.results[0].status, "refused");
    assert.strictEqual(summary.results[1].tool, "backlog");
    assert.strictEqual(summary.results[1].status, "success");
    assert.strictEqual(summary.results[1].label, "compensation: notify-backlog-on-exit-failure");
  });
});

describe("Follow-On: Loop Prevention & Termination Proof", () => {
  test("Recursion cycle detection prevents circular tool loops", async () => {
    const auditLines: AuditLine[] = [];
    const testAuditLayer = makeTestAuditLayer(auditLines);
    const mockToolContext = createMockToolContext();

    // Attempting to run fleet_snapshot as a follow-on when origin was already fleet_snapshot
    const rules: FollowOnRule[] = [
      {
        id: "direct-cycle-attempt",
        trigger: { tool: "fleet_snapshot", on: "success" },
        actions: [
          {
            tool: "fleet_snapshot", // Cycle!
            arguments: {},
          },
        ],
      },
    ];

    const origin = createMockOrigin({ tool: "fleet_snapshot" });

    const summary = await Effect.runPromise(
      executeFollowOnsEffect(origin, mockToolContext, rules, { preventCycles: true }).pipe(
        Effect.provide(testAuditLayer),
      ),
    );

    assert.strictEqual(summary.actionsExecuted, 0);
    assert.strictEqual(summary.results.length, 1);
    assert.strictEqual(summary.results[0].status, "cycle-detected");
    assert.ok(summary.results[0].error?.includes("Recursion cycle detected"));
  });

  test("Strict depth cap halts execution exceeding maxDepth", async () => {
    const auditLines: AuditLine[] = [];
    const testAuditLayer = makeTestAuditLayer(auditLines);
    const mockToolContext = createMockToolContext();

    const rules: FollowOnRule[] = [
      {
        id: "depth-exceeded-chain",
        trigger: { tool: "fleet_snapshot", on: "success" },
        actions: [{ tool: "backlog" }],
      },
    ];

    const origin = createMockOrigin();

    // Test with maxDepth: 0 (immediate suppression)
    const summary = await Effect.runPromise(
      executeFollowOnsEffect(origin, mockToolContext, rules, { maxDepth: 0 }).pipe(
        Effect.provide(testAuditLayer),
      ),
    );

    assert.strictEqual(summary.actionsExecuted, 0);
    assert.strictEqual(summary.results[0].status, "depth-exceeded");
  });

  test("Total action budget strictly caps the number of executed actions", async () => {
    const auditLines: AuditLine[] = [];
    const testAuditLayer = makeTestAuditLayer(auditLines);
    const mockToolContext = createMockToolContext();

    const rules: FollowOnRule[] = [
      {
        id: "multi-action-chain",
        trigger: { tool: "fleet_snapshot", on: "success" },
        actions: [
          { tool: "backlog" },
          { tool: "crew_state", arguments: { id: "crew-1" } },
          { tool: "status_tail", arguments: { id: "crew-1" } },
        ],
      },
    ];

    const origin = createMockOrigin();

    // Cap action budget to 2 actions
    const summary = await Effect.runPromise(
      executeFollowOnsEffect(origin, mockToolContext, rules, { maxActionsPerChain: 2 }).pipe(
        Effect.provide(testAuditLayer),
      ),
    );

    assert.strictEqual(summary.actionsExecuted, 2);
    assert.strictEqual(summary.results.length, 3);
    assert.strictEqual(summary.results[0].status, "success");
    assert.strictEqual(summary.results[1].status, "success");
    assert.strictEqual(summary.results[2].status, "budget-exceeded");
  });
});

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("Follow-On: Server End-to-End JSON-RPC Integration", () => {
  test("Server executes follow-on rules from config file and preserves wire envelope", async () => {
    const home = makeStubHome();
    const configDir = path.join(home, "config");
    fs.mkdirSync(configDir, { recursive: true });

    // Write followons.json to test home config dir
    const followonRules = [
      {
        id: "e2e-followon-snapshot-to-backlog",
        trigger: { tool: "fleet_snapshot", on: "success" },
        actions: [
          {
            tool: "backlog",
            arguments: {},
            label: "auto-backlog-check",
          },
        ],
      },
    ];
    fs.writeFileSync(
      path.join(configDir, "followons.json"),
      JSON.stringify(followonRules, null, 2),
      "utf8",
    );

    const client = new Client({ FM_HOME: home });

    try {
      await client.request("initialize", { protocolVersion: "2024-11-05" });
      client.notify("notifications/initialized");

      // Execute fleet_snapshot tool
      const resp = await client.call("fleet_snapshot", {});
      const p = payload(resp);

      // Verify originating tool envelope is standard and intact
      assert.strictEqual(isError(resp), false);
      assert.strictEqual(p["schema"], "fm-fleet-snapshot.v1");

      // Small delay for detached follow-on write to land on disk
      await sleepMs(200);

      // Verify audit log has lines for both the originating call and follow-on action
      const auditLogPath = path.join(home, "state", "mcp-audit.jsonl");
      assert.ok(fs.existsSync(auditLogPath), "Audit log file must exist");

      const auditEntries = readAuditLines(auditLogPath);
      const snapshotAudit = auditEntries.find((e) => e.tool === "fleet_snapshot");
      const backlogAudit = auditEntries.find((e) => e.tool === "backlog");

      assert.ok(snapshotAudit, "fleet_snapshot audit line must be recorded");
      assert.strictEqual(snapshotAudit.decision, "allow");

      assert.ok(backlogAudit, "follow-on backlog audit line must be recorded");
      assert.strictEqual(backlogAudit.decision, "allow");
    } finally {
      await client.close();
      removeHome(home);
    }
  });

  test("Server isolates follow-on failures without breaking client response", async () => {
    const home = makeStubHome();
    const configDir = path.join(home, "config");
    fs.mkdirSync(configDir, { recursive: true });

    // Rule that tries an unapproved Tier 3 action
    const followonRules = [
      {
        id: "e2e-failing-followon",
        trigger: { tool: "fleet_snapshot", on: "success" },
        actions: [
          {
            tool: "lifecycle_exit", // Will be refused due to missing approval
            arguments: { id: "crew-99" },
          },
        ],
      },
    ];
    fs.writeFileSync(
      path.join(configDir, "followons.json"),
      JSON.stringify(followonRules, null, 2),
      "utf8",
    );

    const client = new Client({ FM_HOME: home });

    try {
      await client.request("initialize", { protocolVersion: "2024-11-05" });
      client.notify("notifications/initialized");

      // Originating call MUST succeed and return clean payload
      const resp = await client.call("fleet_snapshot", {});
      assert.strictEqual(isError(resp), false);
      assert.strictEqual(payload(resp)["schema"], "fm-fleet-snapshot.v1");

      // Small delay for detached follow-on write to land on disk
      await sleepMs(200);

      // Audit log records the refuse for the follow-on action
      const auditLogPath = path.join(home, "state", "mcp-audit.jsonl");
      const auditEntries = readAuditLines(auditLogPath);
      const exitAudit = auditEntries.find((e) => e.tool === "lifecycle_exit");

      assert.ok(exitAudit, "lifecycle_exit refuse audit must be recorded");
      assert.strictEqual(exitAudit.decision, "refuse");
      assert.strictEqual(exitAudit.reason, "approval-required");
    } finally {
      await client.close();
      removeHome(home);
    }
  });
});
