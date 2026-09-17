# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

## Build, test, and envelope

- Self-test: `python3 test_client.py` is the standalone stub-home proof of the MCP
  server and the CI conformance job; run it before shipping server changes. It
  includes a fixture that fakes a >30s, >128KB snapshot so the envelope stays
  covered without the live fleet. Other suites: `bash tests/mcp-adapter.test.sh`,
  `tests/fm-mcp-authz.test.sh`, `tests/mcp-schema.test.sh`, `tests/drift-check.test.sh`,
  `tests/fm-manifest.test.sh`, `tests/fm-coverage.test.sh` (support-coverage view:
  `scripts/gen_coverage.py` renders every upstream command area with its mirror
  status into `manifest/COVERAGE.md`; the gate fails on any unclassified command).
- The repo tree has no `bin/`; the server resolves scripts through `FM_HOME/bin`
  (`fm_mcp_server.py:24-25`), defaulting to the live firstmate checkout.
- Envelope (fm_mcp_server.py): `SUBPROCESS_TIMEOUT_S=30`, `MAX_OUTPUT_BYTES=1MB`.
  No call blocks past 30s: `run_script` starts children in their own session
  and kills the whole process group on timeout, auditing a typed timeout
  error. Calls needing longer (live `fm-fleet-snapshot.sh` takes ~110s)
  go through `receipt_submit`/`receipt_status` (receipts under
  `state/mcp-receipts/`, `RECEIPT_TIMEOUT_S=180`, `RECEIPT_TTL_S=3600`,
  per-home confinement).
- `adapter/dispatch.py` carries its own older envelope constants (30s/128KB) behind
  the conformance suite, which overrides timeouts via its own 60s runner; the two
  boundaries are independent and not drift-checked against each other.
- TypeScript sibling (`ts/`, stdio parity, no runtime deps): bun is the
  primary runtime (`bun install`, `bun run test:bun` is the full TS proof:
  validators, envelope, auth, 71-check server suite, conformance fixtures);
  node stays as fallback compat (`npm test` must stay green alongside).
  `bash tests/conformance/ts-parity.sh` diffs py/ts payloads field-for-field
  under both runtimes plus the TS fixtures. The TS path follows the live
  server envelope (30s/1MB + receipts), never the adapter's older pair.
- Cutover: `scripts/fm-mcp-launch.sh --home $FM_HOME` serves the fleet
  local-only over stdio (Python default, `--server ts` for parity); pins
  `FM_HOME`, refuses network flags, never add a repo-root `bin/` (it would
  shadow `$FM_HOME/bin` in server resolution). Both servers append one
  JSON-lines audit record per tools/call (default
  `$FM_HOME/state/mcp-audit.jsonl`; override `FM_AUDIT_LOG`, actor via
  `FM_ACTOR`; approval stored as hash only). Live proof:
  `python3 scripts/cutover_prove.py` writes `CUTOVER-PROOF.md` from a fixed
  scratch home — never the live fleet.
