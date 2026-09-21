# firstmate-mcp-ts — TypeScript sibling of the smarts-only MCP server

An independent implementation of the same behavioral contract the Python
path (`fm_mcp_server.py` + `adapter/` + `auth/`) serves. The shared
contract and tests are the referee between the two paths — this tree was
written against that contract, not translated from the Python source.

Scope: **stdio parity only** — the same 57 tools, validators, envelope,
auth tiers, and subprocess semantics (30s fail-closed timeout, 1MB output
cap, process-group kill on timeout, async receipts for longer work).
No SSE / streamable HTTP (out of scope, same as the Python path).

## Run

Package manager: pnpm. Primary runtime: Bun (faster, leaner). Node 20+ stays as fallback compat.

```sh
pnpm install   # one-time: effect runtime + TypeScript + @types/node (dev)
pnpm run build # compile src/ -> dist/
FM_HOME=/path/to/firstmate bun dist/server.js
```

Node fallback (same wire, same behavior):

```sh
pnpm install
pnpm run build
FM_HOME=/path/to/firstmate node dist/server.js
```

Newline-delimited JSON-RPC on stdio, logs on stderr — the same wire as
`python3 fm_mcp_server.py`, so any client (including `test_client.py`-style
checks) can point at either server unchanged.

## Test

Bun first (primary runtime), node as fallback compat — both must stay green:

```sh
bun run test:bun  # full proof under bun (validators, envelope, auth, server, followon, timeout, receipt, conformance)
pnpm test         # same full proof under node (fallback compat)
```

Split test targets (split-then-hash hybrid architecture):

```sh
bun run test:fast:bun   # fast unit & smarts suites under bun (<3s: validators, envelope, auth, followon, server)
pnpm run test:fast      # fast unit & smarts suites under node (<4s)
bun run test:slow:bun   # slow timing, budget, & receipt proofs under bun (timeout, process-group kill, receipts)
pnpm run test:slow      # slow timing, budget, & receipt proofs under node
bun run conformance:bun # sharded & hash-cached read-tool equivalence fixtures under bun
pnpm run conformance    # sharded & hash-cached read-tool equivalence fixtures under node
```

Conformance shards (parallelizable across CI jobs):
- `read`: snapshot, crew_state, status_tail, diagnostic reads, session tools (`conformance:read` / `conformance:read:bun`)
- `remote`: secondmate remote reads, digests, mail, voice records (`conformance:remote` / `conformance:remote:bun`)
- `system`: system installs, small gaps, side-effect-free invariants (`conformance:system` / `conformance:system:bun`)

`tests/server.test.ts` covers the smarts server surface (handshake, 57 tools, schema, refusals).
`tests/timeout.test.ts` and `tests/receipt.test.ts` cover live timing, envelope, process-group kill, and receipt lifecycle (NEVER-cached).
`tests/conformance-*.test.ts` mirrors upstream conformance hermetically with per-runtime input hashing and hash-skipping on byte-identical inputs.
`tests/proof-cache.test.ts` verifies AST normalization, semantic change invalidation, and proof-manifest lifecycle.

## AST-Based Unit-Test Proof Caching

The TypeScript tree includes an AST-based proof cache (`src/proof/`, `proof-cache/`):

```sh
pnpm run proof:check    # check AST proof status across all contracts
pnpm run proof:explain  # explain fingerprints for a specific test file
pnpm run proof:bench    # benchmark compile vs validation vs execution timing
pnpm run proof:update   # repin passing proofs into proof-cache/manifest.json
```

See `docs/PROOF_CACHE.md` for full design and contract specifications.

Cross-path wire parity (same stub home, same calls, diffed payloads)
lives in the shared suite: `bash tests/conformance/ts-parity.sh`.

## Layout (Effect composition)

Pure contract modules keep their exact wire behavior; Effect Layers/Services
compose them without throwing. Pinned dependency: `effect@3.22.2`
(`pnpm add effect@3.22.2`, `pnpm install` keeps `pnpm-lock.yaml` in sync).

- `src/constants.ts` — server identity, protocol versions, envelope sizes, id/project shapes, modes, verdicts.
- `src/errors.ts` — typed errors (`DeniedFlagError`, `ValidationError`, `ApprovalRequired/InvalidError`, `ExecutableNotFoundError`, `SubprocessTimeoutError`, `SubprocessFailedError`, `Unknown/ForbiddenToolError`, `AuditError`) with legacy payload mapping; no `throw` on the Effect path.
- `src/config.ts` — `ConfigService` Tag + `ConfigLive`/`makeConfigLive`/`makeTestConfig` (FM_HOME resolution, env re-read per layer build).
- `src/validators.ts` — pure boolean checks (ids, projects, notes, approvals, steer text, status lines, state-path confinement) plus `requireId`/`requireProject`/`requireNote`/`requireApproval`/`requireStatePath` Effect variants.
- `src/envelope.ts` — the single internal result shape (`{ok:true,…}` / `{ok:false,error:{code,…}}`) plus `EnvelopeService`/`EnvelopeLive` and `toolErrorToEnvelope`.
- `src/auth.ts` — tier assignments, per-call approval check, approval-token hashing, JSON-lines audit log plus `AuditService`/`AuditLive`/`makeTestAuditLayer` and `checkEffect`/`appendAuditEffect`.
- `src/runner.ts` — fail-closed subprocess runner on Effect: `runScriptEffect` (acquireRelease spawn + process-group kill finalizer + timeout boundary, null-exit maps to typed timeout mirroring the legacy timedOut guard), `RunnerService`/`RunnerLive`/`makeTestRunnerLayer`, `ownedCallEffect`; legacy `runScript`/`ownedCall` Promise signatures delegate to the Effect core so the envelope (30s budget, detached group, SIGTERM → grace → SIGKILL; receipt continuations use `RECEIPT_TIMEOUT_S=180`) stays byte-identical.
- `src/tools.ts` — the 57 tools in feature-manifest order, with the deny-list (`DENY_LIST`, `DENIED_FLAGS`) and the fail-closed async receipts (`receipt_submit` / `receipt_status`); `argvEffect` fails typed, legacy `argv` throws the same message; `liveContextEffect` resolves via `ConfigService`.
- `src/layers.ts` — composition root: `MainLive` merges config + runner + audit + envelope; `DispatchLive` narrows to audit for dispatch.
- `src/server.ts` — stdio JSON-RPC loop (`initialize`, `tools/list`, `tools/call`, `ping`) with `handleToolsCallEffect`/`dispatchMessageEffect` on the service graph and `auditAppendEffect` for the side-channel audit log.

## Parity notes

- Wire payloads match the Python server field-for-field (including the
  `send_message` success shape, which carries `stdout_truncated` but no
  `stderr` body, and `crew_state`, which reports the parsed line even on
  nonzero exit). `parity-py-ts.mjs` pins this.
- Envelope constants match the **server** boundary (`SUBPROCESS_TIMEOUT_S=30`,
  `MAX_OUTPUT_BYTES=1MB`, `RECEIPT_TIMEOUT_S=180`, `RECEIPT_TTL_S=3600`).
  `adapter/dispatch.py` carries its own 30s/128KB pair behind the Python
  conformance suite; the two boundaries are independent (see root
  `AGENTS.md`) and the TS path follows the live server, not the adapter copy.
- `status_tail` splits on `\n` with trailing-newline handling identical to
  Python's `splitlines()` for log files.
