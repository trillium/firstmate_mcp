# Customizable Follow-On Actions for First Mate MCP

## 1. Executive Summary

This document specifies the design, architecture, safety proofs, and implementation contract of **Customizable Follow-On Actions** for the First Mate MCP server (`ts/`, TypeScript sibling with Effect composition).

The feature provides a generalized, declarative hook and action-chain mechanism that allows any MCP tool action to automatically initiate one or more customized next actions upon reaching a defined outcome (success, failure, or completion).

---

## 2. Trigger Model

The trigger model defines when and why a follow-on rule is activated:

### 2.1 Tool Matching
Rules specify the originating tool or set of tools they observe:
- **Exact tool name**: e.g. `tool: "fleet_snapshot"` or `tool: "spawn_crew"`
- **Tool list**: e.g. `tool: ["fleet_snapshot", "backlog", "fleet_poll"]`
- **Wildcard matcher**: `tool: "*"` matches any MCP tool execution

### 2.2 Outcome Selectors (`on`)
Triggers filter based on the terminal status of the originating tool invocation:
- `"success"` (default): Triggers only when `isError === false` (the tool completed cleanly).
- `"failure"` / `"error"`: Triggers only when `isError === true` (the tool failed, timed out, or returned a structured error).
- `"always"` / `"complete"`: Triggers on every completion regardless of `isError`.

### 2.3 Priority Ordering
When multiple rules match a single tool execution, they are evaluated deterministically in descending order of numeric priority (`priority: number`, default `0`). Higher priority rules execute first.

---

## 3. Condition Language

Conditions determine whether a matched rule or individual action should execute. The condition engine is purely declarative and safe (zero `eval` or unsafe code execution), while supporting functional predicates in TypeScript code.

### 3.1 Field Path Navigation
Paths support dot-notation navigation across the execution context:
- `payload.<key>` (e.g. `payload.status`, `payload.records[0].id`): Originating tool result payload.
- `args.<key>` (e.g. `args.task_id`, `args.target`): Originating tool input arguments.
- `previous.payload.<key>` / `previous.args.<key>`: Outcome of the immediately preceding action in the chain.
- `env.<key>` (e.g. `env.stateDir`, `env.actor`): Server environment metadata.
- `isError`, `tool`, `depth`, `traceId`: Top-level execution metadata.

### 3.2 Comparison Operators
- **Equality**: `equals` (`eq`), `not_equals` (`neq`)
- **Strings & Sets**: `contains`, `not_contains`, `starts_with`, `ends_with`, `in`, `not_in`
- **Numeric**: `greater_than` (`gt`), `greater_than_or_equal` (`gte`), `less_than` (`lt`), `less_than_or_equal` (`lte`)
- **Existence & Truthiness**: `exists`, `not_exists`, `truthy`, `falsy`
- **Pattern Matching**: `regex` (safe RegExp evaluation)

### 3.3 Boolean Combinators
Conditions compose via recursive boolean trees:
```json
{
  "and": [
    { "field": "payload.status", "operator": "equals", "value": "healthy" },
    {
      "or": [
        { "field": "payload.activeCount", "operator": "gt", "value": 0 },
        { "field": "args.force", "operator": "truthy" }
      ]
    },
    {
      "not": { "field": "isError", "operator": "equals", "value": true }
    }
  ]
}
```

### 3.4 Programmatic Predicates (TypeScript)
For in-process rule registration, rules can supply a functional predicate:
```ts
predicate: (ctx: FollowOnContext) => boolean | Promise<boolean> | Effect.Effect<boolean>
```

---

## 4. Ordering Semantics & Flow Control

### 4.1 Chain Execution Order
A follow-on rule contains an ordered list of actions: `actions: FollowOnActionDef[]`. Actions execute in strict array index order ($A_0, A_1, \dots, A_{n-1}$).

### 4.2 Modes
- `"sequential"` (default): Actions execute one after another in sequence. Step $k+1$ receives the results of step $k$ in its context.
- `"parallel"`: Actions are dispatched concurrently via Effect fibers.

### 4.3 Flow Control & Failure Halting
- By default, if action $A_k$ fails or is refused, execution halts immediately for that rule to prevent cascading faults (`continueOnError: false`).
- If an action or rule specifies `continueOnError: true`, subsequent actions continue executing regardless of prior failures.

### 4.4 Rollback & Compensation Actions (`onFailure`)
Both individual actions and entire rules can define compensation actions:
- If action $A_k$ fails, its `onFailure: FollowOnActionDef[]` chain is executed.
- If the rule-level chain fails, the rule's top-level `onFailure: FollowOnActionDef[]` compensation actions run in order.

---

## 5. Context & Result Passing (Templating & Forwarding)

### 5.1 Execution Context Structure (`FollowOnContext`)
Every action receives a rich, immutable context:
```ts
interface FollowOnContext {
  readonly origin: OriginContext;      // tool, args, payload, isError, timestamp
  readonly previous: StepContext;      // immediately preceding action's tool, args, payload, status
  readonly chain: readonly StepContext[]; // ordered history of all steps executed in this chain
  readonly env: EnvironmentContext;   // homeDir, binDir, stateDir, dataDir, actor
  readonly depth: number;              // current chain recursion depth
  readonly traceId: string;            // unique 16-hex correlation trace ID
  readonly callStack: readonly string[]; // ancestor call chain for cycle detection
}
```

### 5.2 Argument Templating
Arguments defined in an action template can reference context values:
- **Native Type Preservation**: When an argument string is an exact template `"${path.to.val}"` (e.g. `"${payload.activeCount}"` or `"${payload.ok}"`), the extracted value retains its native type (`number`, `boolean`, `object`, `array`) rather than converting to a string.
- **Embedded String Interpolation**: Strings containing multiple templates or surrounding text (e.g. `"id-${payload.records[0].id}-rechecked"`) are interpolated into formatted strings.
- **Deep Recursive Traversal**: Nested objects and arrays in action `arguments` are recursively resolved and interpolated.
- **Dynamic Builders**: Programmatic rules can supply an `argsBuilder(ctx)` function.

---

## 6. LOAD-BEARING SAFETY PROPERTY: Auth Tiers & Anti-Laundering

### 6.1 The Core Invariant
**"Chained actions must NEVER bypass approval tiers or launder authority (a no-approval trigger may NOT cause an approval-gated action)."**

In First Mate MCP:
- **Tier 1 (Open Reads)**: `fleet_snapshot`, `backlog`, `crew_state`, etc. (No approval required)
- **Tier 2 (Reversible Steers)**: `send_message` (No approval, validated prose)
- **Tier 3 (Authority Writes)**: `lifecycle_exit`, `spawn_crew`, `decision_resolve`, etc. (Explicit `"I authorize ..."` approval required)
- **Tier 4 (External Sends)**: `relay_reply`, `mail_send`, etc. (Explicit approval + relay consent required)
- **Code-Forbidden**: `promote_scout`, `teardown_crew`, `arm_pr_check`, `merge_pr`, `merge_local` (Never allowed; refused as unknown)

### 6.2 Anti-Laundering Enforcement Mechanisms
1. **Mandatory Pre-Execution Auth Gate**: Before ANY follow-on action is dispatched, its computed target `tool` and arguments are validated against `AuditService.check` / `checkEffect`.
2. **Zero Implicit Escalation**: An unapproved trigger (Tier 1 or Tier 2) CANNOT execute a Tier 3 or Tier 4 action unless the action definition itself explicitly supplies a valid approval token starting with `"I authorize"`.
3. **No Authority Laundering Across Steps**: Even if an originating action was Tier 3/4 with valid approval, that approval is NOT automatically inherited or laundered to chained Tier 3/4 actions. Each chained action must independently carry valid authorization.
4. **Forbidden Tools Strictly Blocked**: Code-forbidden tools can never be dispatched by a follow-on action under any circumstances.
5. **Full Audit Line per Action**: Every follow-on action dispatch emits its own JSON-lines audit record to `mcp-audit.jsonl` with `v`, `ts`, `actor`, `tool`, `tier`, `decision` (`allow` / `refuse`), `reason`, `approval_ref`, and `target`.

---

## 7. Failure Isolation & Envelope Integrity

Follow-on actions are executed within an isolated Effect boundary:
1. The originating tool call completes its execution and generates its standard MCP result payload.
2. Follow-on actions run post-completion.
3. Any failure inside a follow-on action (script timeout, validation failure, crash, auth refusal) is captured, audited, and logged within the follow-on system.
4. **The originating tool's JSON-RPC response and envelope contract are NEVER altered, corrupted, or failed by follow-on errors.**

---

## 8. Loop Prevention & Formal Termination Proof

### 8.1 Multi-Layer Guard
To prevent infinite recursion, cascades, or cyclic loops:
1. **Depth Cap (`maxDepth`)**: Default `3`, hard maximum `8`. The originating tool is depth `0`. Any follow-on triggered by origin is depth `1`. Follow-ons triggered by follow-ons are depth `2`. When `depth >= maxDepth`, all further follow-on triggers are strictly suppressed.
2. **Cycle Detection (`visited` / `callStack`)**: The execution context tracks the ancestor call stack `[tool_0, tool_1, ...]`. If an action attempts to call a tool already present in its active ancestor stack, it is immediately halted with `FollowOnCycleError`.
3. **Total Action Budget (`maxActionsPerChain`)**: Default `10`, hard maximum `50`. A hard global limit on the total number of actions that can execute across an entire causal tree for a single root dispatch.

### 8.2 Formal Proof of Termination

**Theorem**: *Every follow-on execution initiated from an originating MCP tool invocation is guaranteed to terminate in finite steps.*

**Proof**:
Let $T_0$ be the root MCP tool invocation.
Define the execution graph $G = (V, E)$ where vertices $v \in V$ represent tool invocations and directed edges $(u, v) \in E$ represent a follow-on action spawned by invocation $u$.

1. **Depth Boundedness**:
   For any path $P = (v_0, v_1, \dots, v_k)$ in $G$ originating at root $v_0 = T_0$:
   By construction, $\text{depth}(v_{i+1}) = \text{depth}(v_i) + 1$.
   The execution engine enforces $\text{depth}(v_i) < D_{max}$, where $D_{max} \in \mathbb{N}^+$ is a strictly positive finite constant ($D_{max} \le 8$).
   Therefore, the length of any path in $G$ is strictly bounded: $|P| \le D_{max}$.

2. **Acyclicity (DAG Property)**:
   For any vertex $v_k$, let $\text{Ancestors}(v_k) = \{v_0, v_1, \dots, v_{k-1}\}$.
   The cycle guard asserts $\text{tool}(v_k) \notin \{\text{tool}(u) \mid u \in \text{Ancestors}(v_k)\}$.
   If $\text{tool}(v_k) \in \text{Ancestors}(v_k)$, the edge is rejected and execution halts.
   Hence, $G$ contains no directed cycles and is a Directed Acyclic Graph (DAG).

3. **Global Action Budget**:
   Let $N(G) = |V| - 1$ be the total number of follow-on actions spawned.
   The engine maintains an atomic counter $C$ incremented on each action execution.
   If $C \ge B_{max}$ (where $B_{max} \le 50$), all further action dispatches are rejected.
   Therefore, $N(G) \le B_{max}$.

Since the depth is bounded by $D_{max}$, the graph is acyclic, and the total vertex count is bounded by $B_{max} + 1$, the execution graph is finite and execution terminates in at most $\min(D_{max}, B_{max})$ sequential steps.
$\blacksquare$

---

## 9. Configuration & Registration

### 9.1 Configuration File (`followons.json`)
The server automatically loads rules from `$FM_FOLLOWON_CONFIG` or `$FM_HOME/config/followons.json` at startup:
```json
[
  {
    "id": "health-check-notification",
    "trigger": { "tool": "fleet_snapshot", "on": "success", "priority": 10 },
    "condition": {
      "field": "payload.backlog.open",
      "operator": "gt",
      "value": 5
    },
    "actions": [
      {
        "tool": "send_message",
        "arguments": {
          "target": "crew-lead",
          "text": "Fleet snapshot indicates backlog pressure (${payload.backlog.open} open tasks)"
        }
      }
    ]
  }
]
```

### 9.2 Programmatic Service API
```ts
const followOn = yield* FollowOnService;
yield* followOn.registerRule({
  trigger: { tool: "scaffold_brief", on: "success" },
  actions: [
    {
      tool: "crew_state",
      arguments: { id: "${origin.args.task_id}" }
    }
  ]
});
```
