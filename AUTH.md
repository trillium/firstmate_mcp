First Mate MCP authorization tiers (smarts-only)

Trillium is the sole authorizer under the owner-ordered smarts-only line of 2026-09-13.
Every authority-bearing or externally visible tool takes an explicit `approval` string starting with `I authorize` and refuses without it.
Reads stay open because they change nothing.
Tier 1 - open reads (no approval): `fleet_snapshot`, `backlog`, `crew_state`, `status_tail`, `fleet_poll`, `peek`, `fleet_view`, `review_diff`, `bearings_snapshot`, `wake_drain`, `guard_check`, `remote_doctor`, `remote_file`, `remote_delta`, `handoff_status`, `harness_detect`, `project_mode`, `lock_status`, `lease_check`, `bearings_board_path`, `inbox_status`, `inbox_list`, `home_summary`, `contributions_snapshot`, `contributions_pending`, `mail_status`, `mail_read`, `voice_status`, `lint_versions`, `tool_update_check`, `vendor_auth_probe`, `startup_memory`, `pr_state`, `relay_poll`, `receipt_submit`, `receipt_status`.
`remote_doctor` runs check mode only (no `--fix`); `remote_file` is get-only with a bounded byte cap; `remote_delta` clamps its wait to 10s; `handoff_status` reads staged outbox files only.
`harness_detect` runs a closed detection-mode subset (no ancestry walks); `project_mode` reports the mapped mode+yolo pair (no `--raw`); `lock_status` and `lease_check` are status reads only (no acquire, claim, release, or sweep); `bearings_board_path` prints the stable board path (no build/arm); `inbox_status`/`inbox_list` read durable records only (no queue, wake, or model call); `home_summary` reads the published ledger (no refresh); `contributions_snapshot`/`contributions_pending` never contact a forge and mutate nothing.
`mail_status` prints config plus cursor (no network, no wake); `mail_read` is a BODY.PEEK digest that never marks mail seen — both stay inert without mail credentials, which live outside MCP in the home `.env` and never cross tool args or logs; `voice_status` reads durable records only (counts by default, no record free text; full only via the captain's own read-scope, deny list enforced inside the helper; no mic, no Bedrock, no audio); `lint_versions` prints the required ShellCheck/actionlint pins only; `tool_update_check` reports only (repairs/installs nothing); `vendor_auth_probe` runs one bounded probe from the closed allowlist and prints one sanitized line (raw vendor output never leaves the script); `startup_memory` reads the validated budget or local estimate (never creates config); `pr_state` is a one-shot blockers read over a validated GitHub PR URL (never posts); `relay_poll` is a short bounded poll that is a hard no-op without relay consent.
`receipt_submit` detaches one tool call past the 30s fail-closed budget and returns a pending receipt; authority targets still need their own nested approval string. `receipt_status` reports running/done/failed for one receipt.
Tier 2 - reversible steers (no approval, validated text): `send_message` wraps only the plain-text `fm-send.sh` path with a 500-char single-line cap and a slash-command refusal.
Tier 3 - launch-authorized writes (approval required): `lifecycle_interrupt`, `lifecycle_exit`, `lifecycle_relaunch`, `lifecycle_suspend`, `lifecycle_resume`, `spawn_crew`, `scaffold_brief`, `decision_hold`, `decision_resolve`, `review_decision`, `secondmate_nudge`, `secondmate_restart`, `secondmate_report`, `remote_control`, `handoff_move`, `voice_queue`.
Lifecycle verbs are launch control only: they drive agent lifecycle and never touch repos directly.
Secondmate/remote verbs carry the same safe-subset discipline: `secondmate_nudge` is notify-only, `secondmate_restart` takes ids only, `secondmate_report` is the note-only form with the destination resolved by the owning helper, `remote_control` is the closed state/route/observe/send subset (no launch, no raw pane access, no remote teardown), and `handoff_move` moves only queued items or resumes pending wakes. Provisioning new secondmate homes stays out (firstmate-owned) unless read-only status.
`spawn_crew` and `scaffold_brief` carry only the safe subset of flags with no repo-mutation options.
`voice_queue` hands one single-line request to firstmate through the handover queue (no microphone, no audio, no Bedrock session; the mic client and the Bedrock relay have no tool — mic hardware and AWS credentials stay out of MCP).
Downstream code work stays under the owning scripts with merge authority, yolo posture, and decision-hold lifecycle.
Tier 4 - external sends (approval required, relay-gated): `relay_reply`, `relay_dismiss`, `relay_followup`, `mail_send` shell to the owning `fm-x-*.sh` / `fm-mail.sh` scripts and stay inert without relay/mail consent.
`mail_send` carries a validated to/subject plus a body piped via stdin (never in argv, never logged); SMTP credentials live outside MCP in the home `.env`.
Code-forbidden (no tool, refused as unknown): `promote_scout`, `teardown_crew`, `arm_pr_check`, `merge_pr`, `merge_local`.
No edit, commit, merge, or PR tools exist in this layer.
No direct repo mutation paths exist in this layer.
No teardown that discards work exists in this layer.
No promote-to-ship paths exist in this layer.
Safety notes that survive the smarts-only trim.
The MCP layer never reimplements policy: every tool shells to the owning `bin/` script and the script still fails closed.
Relay sends still require relay consent (`FMX_PAIRING_TOKEN`) and follow-up budgets inside the owning scripts.
`FM_HOME` is inherited from the server environment, so pin it at launch and do not expose it as a tool argument.
