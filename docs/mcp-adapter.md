# MCP compatibility adapter

The adapter (`adapter/`) is the only layer allowed to know First Mate internals.
Every MCP tool calls the adapter, the adapter shells to the owning `bin/fm-*.sh` script (never reimplements), validates ids/paths/text limits, and returns a typed result/error envelope.
Default path: MCP tool -> adapter -> real operation.

## Layout

`adapter/validators.py` holds pure input checks ported from the PoC: id format, project confinement (no absolute paths, no traversal), single-line text caps, approval strings, and state-path confinement to the served home.
`adapter/envelope.py` holds the single result shape: `{"ok": True, ...}` for success and `{"ok": False, "error": {"code", "message", ...}}` for failure.
`adapter/dispatch.py` holds the `Adapter` class (one instance serves one pinned home), the tool registry mapping each tool name to its owning script plus argv builder, the shared fail-closed `run_script`/`owned_call` path, and the explicit deny-list.
`tests/mcp-adapter.test.py` holds the hermetic unit suite (fake runner, temp home); `tests/mcp-adapter.test.sh` is its runner entry point.

## Boundary rule

The adapter may shell to an owning script with a safe flag subset.
It may not reimplement script behavior, invent flags, touch repos directly, control daemons, or reach any surface in `DENY_LIST`.
`DENY_LIST` covers code-writing and landing tools (`promote_scout`, `teardown_crew`, `arm_pr_check`, `merge_pr`, `merge_local`), daemon and supervision control (`daemon_start/stop/restart`, `watch_start/stop`), and direct repo mutation (`repo_edit/commit/push/merge`).
Denied and unknown tools are refused before any process starts, and validation rejections fire before any side effect.
`run_script` additionally refuses any script outside the registry allow-list, so a bad table entry fails closed.
Denied argv flags (`--key`, `--raw`, `--force`, `--yes`, `--force-with-lease`) can never be emitted by a builder.

## Authorization tiers

Reads (`fleet_snapshot`, `backlog`, `crew_state`, `status_tail`, `fleet_poll`, `peek`, `fleet_view`, `review_diff`, `bearings_snapshot`, `wake_drain`, `guard_check`) and the single safe steer (`send_message`, plain prose, 500-char single line, slash commands refused) need no approval.
Every authority-bearing or externally visible tool requires an explicit `approval` string starting with `I authorize`.
Relay sends stay inert without relay consent inside the owning scripts, and downstream code work stays under merge authority, yolo posture, and the decision-hold lifecycle.

## Test

Run `python3 tests/mcp-adapter.test.py` for the unit suite, or `bin/fm-test-run.sh tests/mcp-adapter.test.sh` for the canonical timed path.
