First Mate MCP proof of concept

This directory is exploratory scaffolding for task-gluj4 and ships local-only with no PR and no merge.
First Mate stays the implementation and this layer only exposes existing capabilities as typed tools.
This line is smarts-only: launch ability yes and development ability no per the owner order of 2026-09-13.

## Layout

`fm_mcp_server.py` is the stdio MCP server with zero dependencies beyond Python 3.
`test_client.py` is the external-client proof that handshakes and exercises every tool.
`INVENTORY.md` holds the full capability inventory and the typed mapping with read-versus-write boundaries.
`FINDINGS.md` holds the smarts-only results, the launch-authorized posture, and the residual risks.
`AUTH.md` holds the smarts-only authorization tiers with the explicit approval rule and the code-forbidden list.

## Run

Start the server with `python3 poc-mcp/fm_mcp_server.py` speaking newline-delimited JSON-RPC on stdio.
The server resolves its checkout root from its own path and passes `FM_HOME` through, defaulting to that root.
Logs go to stderr so stdout stays pure protocol.

## Test

Run `python3 poc-mcp/test_client.py` for the 67-check end-to-end proof.
The suite covers handshake, tool listing, snapshot schema, backlog, current state, traversal refusals, steer validation, fail-closed steering, protocol errors, launch-tool refusal paths in a sandbox home, and unknown-tool proof for every removed code-writing surface.

## Tools

Reads: `fleet_snapshot`, `backlog`, `crew_state`, and `status_tail`.
Single safe write: `send_message`, which wraps only the verified plain-text `fm-send.sh` path.
Launch-authorized writes (approval required): lifecycle verbs, `spawn_crew`, `scaffold_brief`, `decision_hold`, `decision_resolve`, and `review_decision`.
External sends (approval required): `relay_reply`, `relay_dismiss`, and `relay_followup`.
Read-only poller: `fleet_poll` over `fleet_snapshot`; see `AUTH.md` for the tier list.
Code-forbidden with no tool: `promote_scout`, `teardown_crew`, `arm_pr_check`, `merge_pr`, and `merge_local`.
