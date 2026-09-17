# firstmate-mcp-ts — TypeScript sibling of the smarts-only MCP server

An independent implementation of the same behavioral contract the Python
path (`fm_mcp_server.py` + `adapter/` + `auth/`) serves. The shared
contract and tests are the referee between the two paths — this tree was
written against that contract, not translated from the Python source.

Scope: **stdio parity only** — the same 19 tools, validators, envelope,
auth tiers, and subprocess semantics (180s timeout, 1MB output cap,
process-group kill on timeout). No SSE / streamable HTTP (out of scope,
same as the Python path).

## Run

Requirements: Node 20+, no runtime dependencies (built-ins only).

```sh
npm install   # one-time: TypeScript + @types/node (dev only)
npm run build # compile src/ -> dist/
FM_HOME=/path/to/firstmate node dist/server.js
```

Newline-delimited JSON-RPC on stdio, logs on stderr — the same wire as
`python3 fm_mcp_server.py`, so any client (including `test_client.py`-style
checks) can point at either server unchanged.

## Test

```sh
npm test         # full proof: 128 checks (validators, envelope, auth, server, conformance)
npm run test:fast # pure unit suites only (no subprocess, <1s)
npm run conformance # read-tool equivalence fixtures only
```

`tests/server.test.ts` mirrors the upstream 67-check proof (stub homes via
`FM_HOME`, approval gating, traversal refusals, the >30s / >128KB envelope
fixture). `tests/conformance.test.ts` mirrors
`tests/conformance/test_conformance.py` hermetically (no live checkout).

Cross-path wire parity (same stub home, same calls, diffed payloads)
lives in the shared suite: `bash tests/conformance/ts-parity.sh`.

## Layout

- `src/constants.ts` — server identity, protocol versions, envelope sizes, id/project shapes, modes, verdicts.
- `src/validators.ts` — pure input checks (ids, projects, notes, approvals, steer text, status lines, state-path confinement).
- `src/envelope.ts` — the single internal result shape (`{ok:true,…}` / `{ok:false,error:{code,…}}`).
- `src/auth.ts` — tier assignments, per-call approval check, approval-token hashing, JSON-lines audit log.
- `src/runner.ts` — fail-closed subprocess runner (detached process group, SIGTERM → grace → SIGKILL on timeout).
- `src/tools.ts` — the 19 tools in feature-manifest order, with the deny-list (`DENY_LIST`, `DENIED_FLAGS`).
- `src/server.ts` — stdio JSON-RPC loop (`initialize`, `tools/list`, `tools/call`, `ping`).

## Parity notes

- Wire payloads match the Python server field-for-field (including the
  `send_message` success shape, which carries `stdout_truncated` but no
  `stderr` body, and `crew_state`, which reports the parsed line even on
  nonzero exit). `parity-py-ts.mjs` pins this.
- Envelope constants match the **server** boundary (`SUBPROCESS_TIMEOUT_S=180`,
  `MAX_OUTPUT_BYTES=1MB`). `adapter/dispatch.py` carries its own older
  30s/128KB pair behind the Python conformance suite; the two boundaries
  are independent (see root `AGENTS.md`) and the TS path follows the live
  server, not the adapter copy.
- `status_tail` splits on `\n` with trailing-newline handling identical to
  Python's `splitlines()` for log files.
