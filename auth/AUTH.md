# First Mate MCP authorization tiers

This file is the enforced authorization model for the MCP layer, covering the server (`fm_mcp_server.py`) and the adapter built on it.
It ports and generalizes `AUTH.md` from the smarts-only trim into the standing contract.
Trillium is the sole authorizer.
Every authority-bearing or externally visible tool takes an explicit per-call `approval` string and refuses without it.
Reads stay open because they change nothing.
No ambient authority exists: environment flags, prior grants, roles, and session state never substitute for the per-call string.

## Tier 1 - open reads (no approval)

These tools change nothing and take no `approval` argument: `fleet_snapshot`, `backlog`, `crew_state`, `status_tail`, `fleet_poll`, `peek`, `fleet_view`, `review_diff`, `bearings_snapshot`, `wake_drain`, `guard_check`, `receipt_submit`, `receipt_status`.
`fleet_poll` is a read-only convenience poller over `fleet_snapshot`, and the snapshot stays canonical.
`receipt_submit` detaches one tool call past the 30s fail-closed budget and returns a pending receipt; when the named tool is Tier 3/4 the nested arguments must still carry that tool's own `approval` string. `receipt_status` reports running/done/failed for one receipt with the result attached on completion.

## Tier 2 - reversible steers (no approval, validated text)

`send_message` wraps only the plain-text `fm-send.sh` path with a 500-char single-line cap and a slash-command refusal.
Delivery of a steer is verified submit, never a reply, and lifecycle verbs are never reachable through it.

## Tier 3 - authority writes (approval required)

These tools drive agent lifecycle and durable decisions through the owning `bin/` scripts: `lifecycle_interrupt`, `lifecycle_exit`, `lifecycle_relaunch`, `lifecycle_suspend`, `lifecycle_resume`, `spawn_crew`, `scaffold_brief`, `decision_hold`, `decision_resolve`, `review_decision`.
Lifecycle verbs are launch control only: they drive agent lifecycle and never touch repos directly.
`spawn_crew` and `scaffold_brief` carry only the safe subset of flags with no repo-mutation options.
Downstream code work stays under the owning scripts with merge authority, yolo posture, and decision-hold lifecycle.

## Tier 4 - external sends (approval required, relay-gated)

These tools send public replies through the owning Relay scripts: `relay_reply`, `relay_dismiss`, `relay_followup`.
They shell to the owning `fm-x-*.sh` scripts and stay inert without relay consent.
Relay budgets and consent live in those scripts, not in this layer.

## Code-forbidden (no tool, refused as unknown)

These operations have no MCP tool and are refused as unknown: `promote_scout`, `teardown_crew`, `arm_pr_check`, `merge_pr`, `merge_local`.
No edit, commit, merge, or PR tools exist in this layer.
No direct repo mutation paths exist in this layer.
No teardown that discards work exists in this layer.
No promote-to-ship paths exist in this layer.

## Approval-token mechanics

The token is an explicit per-call `approval` argument, required on Tier 3 and Tier 4 and absent from Tier 1 and Tier 2 schemas.
A token is valid if and only if it is a string starting with `I authorize` and at most 500 chars long.
The recommended human form names the action: `I authorize <tool> on <target> (<date>)`.
A missing token refuses with `approval-required` and a malformed one with `approval-invalid`.
Tokens are single-call and non-delegable: one string authorizes exactly the call that carries it.
The audit log records only a truncated hash (`approval_ref`), never the token text.

## Audit log format

Every allow and every refuse appends exactly one JSON object per line.
Each line carries these keys: `v` (format version, currently 1), `ts` (UTC `YYYY-MM-DDTHH:MM:SSZ`), `actor` (invoking identity), `tool` (requested tool name), `tier` (1, 2, 3, 4, `forbidden`, or null when unknown), `decision` (`allow` or `refuse`), `reason` (`ok`, `approval-required`, `approval-invalid`, `validation-failed`, `unknown-tool`, or `forbidden`), `approval_ref` (16 hex chars of the token hash, or null when no token was presented), and `target` (primary id or null).
Example: `{"actor": "trillium", "approval_ref": "9f2c…", "decision": "allow", "reason": "ok", "target": "fm-task1", "tier": 3, "tool": "lifecycle_interrupt", "ts": "2026-09-13T18:00:00Z", "v": 1}`.

## Safety notes

The MCP layer never reimplements policy: every tool shells to the owning `bin/` script and the script still fails closed.
`FM_HOME` is inherited from the server environment, so pin it at launch and do not expose it as a tool argument.
Treat approval strings as per-action captain consent, and keep this layer local-only on a pinned home before any networked or multi-user wiring.
