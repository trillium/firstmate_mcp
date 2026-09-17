# Upstream test preservation harness

Runs upstream firstmate's own tests **unchanged** against BOTH the Python
and TypeScript MCP paths, with the thinnest practical adapter at language
boundaries — never rewritten expectations.

This directory owns ingestion + harness only. The shared conformance
referee lives in `tests/conformance/` (task-8d0ah.3); intentional
divergences live in `divergences.json` (task-8d0ah.9).

## What it does

For each entry in `manifest.json` (one per depended-on surface in
`schema/contracts.yaml`):

1. **Upstream reference** — executes the upstream test file verbatim
   (`bash <upstream>/tests/<file>`) with no patches, no env rewrites
   beyond a temp `TMPDIR`. Captures exit code + tail. Skips cleanly when
   no upstream checkout is available (same rule as
   `tests/conformance/conformance.sh`).
2. **Python path** — exercises the depended-on MCP tool(s) through
   `python3 fm_mcp_server.py` against a stub `FM_HOME` (same stub style
   as `test_client.py` / `parity-py-ts.mjs`). Verifies the typed
   projection, validation refusals, and fail-closed stub errors.
3. **TypeScript path** — same tool sequence through the TS server
   (`ts/dist/server.js` under bun-primary, node-fallback). Payloads must
   match the Python path field-for-field.

The language-boundary adapters are deliberately thin:

- `adapters/mcp_call.py` — one MCP `tools/call` over stdio to the Python
  server, no assertion logic.
- `adapters/mcp_call.mjs` — same call against the TS server (runtime
  selected by `process.execPath`, so `node` proves node, `bun` proves bun).

All assertions live in `run_upstream.py`, never in the adapters, and never
by editing the upstream test.

## Divergence rule (task-8d0ah.9)

A test ceases to be expected-to-pass **only** with an explicit entry in
`divergences.json` pointing at the manifest reason. Every non-passing
upstream test is either implemented, in-progress with owner, or marked
intentional with replacement tests. Unmarked failures fail the harness.

Seeded intentional divergences (all pre-existing, documented in
`README.md` / `AUTH.md` / `tests/conformance/README.md`):

- `div-stricter-id` — adapter refuses traversal ids (`invalid-id`) before
  spawn; raw script answers lax `unknown`. Stricter-is-conformant.
- `div-approval-gating` — Tier 3/4 MCP tools require `I authorize`;
  upstream scripts have no such gate.
- `div-deny-list` — smarts-only deny-list has no MCP tool (`unknown-tool`);
  upstream code-writing/landing surfaces stay reachable only in firstmate.
- `div-envelope` — MCP wraps outputs in the typed ok/err envelope with
  schema validation, caps, and timeouts; raw script output shape differs.

## Run

```sh
bash tests/upstream/run_upstream.sh
# or directly:
python3 tests/upstream/run_upstream.py --format text
python3 tests/upstream/run_upstream.py --format json
python3 tests/upstream/run_upstream.py --write-results  # refreshes UPSTREAM-RESULTS.md
```

Resolution order for the upstream checkout (read-only input, never mutated):

1. `sources/firstmate` submodule (authoritative pin when populated)
2. `$FIRSTMATE_HOME` / `$FM_REAL_HOME` / `$FM_CHECKOUT`
3. Well-known live checkout beside this repo (developer convenience only)

Without any checkout the upstream-reference column reports `skip` and the
py/ts projection columns still run hermetically (exit 0). Missing `bun`
or `node` similarly skips only the TS column it blocks.

## Layout

- `manifest.json` — selected upstream tests + depended-on contract linkage
  + provenance (upstream repo + gitlink pin).
- `divergences.json` — intentional-divergence registry + replacement tests.
- `run_upstream.py` — harness (stdlib only, no deps).
- `run_upstream.sh` — CI entrypoint (builds `ts/dist` if missing, then runs
  the harness under both TS runtimes where available).
- `adapters/` — thinnest stdio call shims, one per language.
- `UPSTREAM-RESULTS.md` (repo root) — seeded per-test, per-path verdicts.
