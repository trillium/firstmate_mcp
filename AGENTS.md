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
  `tests/fm-mcp-authz.test.sh`, `tests/mcp-schema.test.sh`, `tests/drift-check.test.sh`.
- The repo tree has no `bin/`; the server resolves scripts through `FM_HOME/bin`
  (`fm_mcp_server.py:24-25`), defaulting to the live firstmate checkout.
- Envelope (fm_mcp_server.py): `SUBPROCESS_TIMEOUT_S=180`, `MAX_OUTPUT_BYTES=1MB`,
  sized to the live `fm-fleet-snapshot.sh` (~110s, ~500KB, ~42 tasks). `run_script`
  starts children in their own session and kills the whole process group on
  timeout, so timed-out fleet reads leave no orphan compute.
- `adapter/dispatch.py` carries its own older envelope constants (30s/128KB) behind
  the conformance suite, which overrides timeouts via its own 60s runner; the two
  boundaries are independent and not drift-checked against each other.
