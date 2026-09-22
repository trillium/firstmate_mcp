# Contract matrix view

Read this table left to right: surface, owning command, tier, depended-on flag subset, consumer.
Rows marked depended-on break the superset when they change; observed-only rows never do.

| Surface | Command | Tier | Depended-on flags | Consumer |
| --- | --- | --- | --- | --- |
| fleet_snapshot | bin/fm-fleet-snapshot.sh | stable | --json | snapshot, backlog, poll reads |
| backlog | derived: fleet_snapshot | stable | --json | dispatch reads |
| crew_state | bin/fm-crew-state.sh | stable | <id> | current-state reads |
| status_tail | file: state/<id>.status | stable | <id>, lines=1..50 | dispatch reads |
| send_message | bin/fm-send.sh | stable | <target> <text> | safe steer write |
| peek | bin/fm-peek.sh | stable | <target>, lines=1..100 | bounded endpoint-tail reads |
| fleet_view | bin/fm-fleet-view.sh | stable | <none> | human fleet-render reads |
| review_diff | bin/fm-review-diff.sh | stable | <task-id>, --stat | branch-vs-base diff reads |
| bearings_snapshot | bin/fm-bearings-snapshot.sh | stable | --json | pick-up digest reads (local-only) |
| wake_drain | bin/fm-wake-drain.sh | stable | <none> | drained-wake record reads |
| guard_check | bin/fm-guard.sh | stable | <none> | liveness/tangle verdict reads |
| remote_doctor | bin/fm-remote-doctor.sh | stable | <none> | remote readiness diagnostic reads (check mode) |
| remote_file | bin/fm-remote-file.sh | stable | get, <relative-path>, <max-bytes> | bounded home-relative file reads |
| remote_delta | bin/fm-remote-delta-read.sh | stable | <relative-log>, <offset>, <prefix-sha256>, wait 0..10 | continuity-checked log delta reads |
| extension_list | bin/fm-extension.sh | stable | list | enabled home-local extension binding reads |
| extension_inspect | bin/fm-extension.sh | stable | inspect, <extension-id> | single home-local extension binding reads |
| handoff_status | file: data/handoff/<id>.outbox.md | stable | <id>, lines=1..20 | staged handoff outbox reads |
| secondmate_nudge | bin/fm-secondmate-reconcile.sh | evolving | notify | cooldown-guarded reconcile asks |
| secondmate_restart | bin/fm-secondmate-restart.sh | evolving | <secondmate-id>... | persist-gated secondmate restarts |
| secondmate_report | bin/fm-secondmate-report.sh | evolving | <verb>, <corr>, <note> | correlated parent-channel reports |
| remote_control | bin/fm-remote-secondmate-control.sh | evolving | state, route, observe, send | closed remote secondmate control subset |
| handoff_move | bin/fm-backlog-handoff.sh | evolving | <secondmate-id>, <item-key>..., --resume-pending | queued-item handoff moves |
| harness_detect | bin/fm-harness.sh | stable | own, crew, secondmate, secondmate-model, secondmate-effort | harness detection reads (no ancestry walks) |
| project_mode | bin/fm-project-mode.sh | stable | <project> | registered mode+yolo posture reads |
| lock_status | bin/fm-lock.sh | stable | status | per-home session lock status reads |
| lease_check | bin/fm-lease.sh | stable | check, <task> | per-task supervision lease reads |
| bearings_board_path | bin/fm-bearings-board.sh | stable | path | stable bearings board path reads |
| inbox_status | bin/fm-inbox.sh | stable | status | durable-records inbox status reads (no wake) |
| inbox_list | bin/fm-inbox.sh | stable | list | queued inbox note reads |
| home_summary | file: state/home-summary.json | stable | <none> | published home-summary ledger reads |
| home_summary_refresh | bin/fm-home-summary-refresh.sh | stable | --best-effort | published home-summary atomic refresh |
| contributions_snapshot | bin/fm-contributions.sh | stable | snapshot, <contribution-input>, --all | owned-contribution coverage reads (no forge) |
| contributions_pending | bin/fm-contributions.sh | stable | pending | pending contribution token reads |
| mail_status | bin/fm-mail.sh | stable | status | mail config + cursor reads (no network) |
| mail_read | bin/fm-mail.sh | stable | read | unseen-INBOX digest reads (BODY.PEEK) |
| mail_check | bin/fm-mail-check.sh | stable | check | inbound received-mail check reads (no arm/disarm) |
| mail_send | bin/fm-mail.sh | evolving | send, <to>, <subject>, - | SMTP send subset (body via stdin) |
| voice_status | bin/fm_voice_records.py | stable | status, --scope | voice status reads (no mic, no Bedrock) |
| voice_queue | bin/fm_voice_records.py | evolving | queue, <text> | handover queue writes |
| lint_versions | bin/fm-lint.sh | stable | --required-version | ShellCheck/actionlint pin reads |
| tool_update_check | bin/fm-tool-update-check.sh | stable | check | watched-tool update reports |
| vendor_auth_probe | bin/fm-vendor-auth-probe.sh | stable | <probe> | bounded vendor auth probes |
| startup_memory | bin/fm-startup-memory-budget.sh | stable | read, report | startup-memory budget reads |
| pr_state | bin/fm-pr-state.sh | stable | <pr-url> | PR blockers reads (no posts) |
| pr_poll | bin/fm-pr-poll.sh | stable | --validated, github, <pr-url>, github.com, <path>, <number> | static merge-poll watcher check source |
| pr_reviewers | bin/fm-pr-reviewers.sh | stable | <pr-url> | advisory reviewer-candidate reads (no requests) |
| arm_policy_check | bin/fm-arm-pretool-check.sh | stable | --command | watcher-arm policy classification reads (no execution) |
| cd_policy_check | bin/fm-cd-pretool-check.sh | stable | --command | cd-guard policy classification reads (no execution) |
| subagent_policy_check | bin/fm-subagent-pretool-check.sh | stable | --tool | subagent-guard classification reads (no delegation) |
| supervision_instructions | bin/fm-supervision-instructions.sh | stable | --harness | supervision operating-block render reads |
| quota_choose | bin/fm-quota-choose.sh | stable | --candidate | quota-eligible candidate selection reads (no snapshot) |
| relay_poll | bin/fm-x-poll.sh | stable | <none> | relay short-poll reads (inert without consent) |
| public_followup_pending | bin/fm-public-followup.sh | stable | pending | open public-followup loop digest |
| public_followup_collect | bin/fm-public-followup-collect.sh | stable | drain <obligation-id> | read staged terminal events non-destructively |
| tasks_list | bin/fm-tasks-axi.sh | evolving | list, --state, --repo, --kind, --blocked, --limit, --fields | backlog item listing reads |
| tasks_show | bin/fm-tasks-axi.sh | evolving | show, <id>, --full | single-task detail inspection reads |
| tasks_ready | bin/fm-tasks-axi.sh | evolving | ready, --repo, --include-held | dispatchable ready queued task reads |
| dispatch_resolve | bin/fm-dispatch-resolve.sh | evolving | <brief>, --project | dispatch plan reads (never launches) |
| sessionstart_nudge | bin/fm-sessionstart-nudge.sh | evolving | <none> | session-start nudge reads |
| startup_network_report | bin/fm-startup-network.sh | evolving | report | deferred startup-network stage report reads |
| doc_audience_check | bin/fm-doc-audience-check.sh | evolving | --root | docs inventory + local-link validation reads |
| home_seed_validate | bin/fm-home-seed.sh | evolving | validate | secondmate-registry validation reads |
| stow_cascade | bin/fm-stow-cascade.sh | evolving | <none> | stow cascade enumeration reads |
| test_isolation_list | bin/fm-test-isolation-proof.sh | evolving | --list, --pool | isolation-proof topology reads |
| test_run_list | bin/fm-test-run.sh | evolving | --list-families | test-runner topology reads |
| spawn_crew | bin/fm-spawn.sh | evolving | task, project, mode, yolo | dispatch writes |
| scaffold_brief | bin/fm-brief.sh | evolving | task, repo, mode/scout | dispatch writes |
| receipt_submit | native: receipt store (state/mcp-receipts/) | experimental | <tool> <arguments> | detach long calls past the 30s budget |
| receipt_status | native: receipt store (state/mcp-receipts/) | experimental | <receipt_id> | running/done/failed checks with result on completion |
| grant_mint | native: standing grant store (state/mcp-grants/) | experimental | <grantee>, tier_limit, tools, projects, ttl_s, max_uses, note, <approval> | scoped standing approval grant minting |
| grant_revoke | native: standing grant store (state/mcp-grants/) | experimental | <grant_id>, reason, <approval> | standing approval grant revocation |
| grant_status | native: standing grant store (state/mcp-grants/) | experimental | grant_id, grantee | standing approval safe metadata inspection reads |

## How to use this view

Filter schema/contracts.yaml by stability to answer what breaks when a script header changes.
A stable row pins an exact output schema id and fails validation when the pin goes stale.
An evolving row pins a safe flag subset and fails when flags outside the subset appear.
Nothing in this map is observed-only yet; when an observed surface arrives, it enters with tier experimental and no pin.
