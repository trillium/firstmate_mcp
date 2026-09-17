First Mate MCP authorization tiers (smarts-only)

Trillium is the sole authorizer under the owner-ordered smarts-only line of 2026-09-13.
Every authority-bearing or externally visible tool takes an explicit `approval` string starting with `I authorize` and refuses without it.
Reads stay open because they change nothing.
Tier 1 - open reads (no approval): `fleet_snapshot`, `backlog`, `crew_state`, `status_tail`, `fleet_poll`, `peek`, `fleet_view`, `review_diff`, `bearings_snapshot`, `wake_drain`, `guard_check`, `receipt_submit`, `receipt_status`.
`receipt_submit` detaches one tool call past the 30s fail-closed budget and returns a pending receipt; authority targets still need their own nested approval string. `receipt_status` reports running/done/failed for one receipt.
Tier 2 - reversible steers (no approval, validated text): `send_message` wraps only the plain-text `fm-send.sh` path with a 500-char single-line cap and a slash-command refusal.
Tier 3 - launch-authorized writes (approval required): `lifecycle_interrupt`, `lifecycle_exit`, `lifecycle_relaunch`, `lifecycle_suspend`, `lifecycle_resume`, `spawn_crew`, `scaffold_brief`, `decision_hold`, `decision_resolve`, `review_decision`.
Lifecycle verbs are launch control only: they drive agent lifecycle and never touch repos directly.
`spawn_crew` and `scaffold_brief` carry only the safe subset of flags with no repo-mutation options.
Downstream code work stays under the owning scripts with merge authority, yolo posture, and decision-hold lifecycle.
Tier 4 - external sends (approval required, relay-gated): `relay_reply`, `relay_dismiss`, `relay_followup` shell to the owning `fm-x-*.sh` scripts and stay inert without relay consent.
Code-forbidden (no tool, refused as unknown): `promote_scout`, `teardown_crew`, `arm_pr_check`, `merge_pr`, `merge_local`.
No edit, commit, merge, or PR tools exist in this layer.
No direct repo mutation paths exist in this layer.
No teardown that discards work exists in this layer.
No promote-to-ship paths exist in this layer.
Safety notes that survive the smarts-only trim.
The MCP layer never reimplements policy: every tool shells to the owning `bin/` script and the script still fails closed.
Relay sends still require relay consent (`FMX_PAIRING_TOKEN`) and follow-up budgets inside the owning scripts.
`FM_HOME` is inherited from the server environment, so pin it at launch and do not expose it as a tool argument.
