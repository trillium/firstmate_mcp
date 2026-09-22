# MCP TypeScript Server & Adapter Boundary

The TypeScript MCP server (`ts/`) is the only layer allowed to know First Mate internals.
Every MCP tool calls the tool handler, shells to the owning `bin/fm-*.sh` script (never reimplements), validates ids/paths/text limits, and returns a typed result/error envelope.
Default path: MCP tool -> TS handler -> real operation.

## Layout

`ts/src/validators.ts` holds pure input checks: id format, project confinement (no absolute paths, no traversal), single-line text caps, approval strings, and state-path confinement to the served home.
`ts/src/envelope.ts` holds the typed envelope mapping: `ok(payload)` for success and `err(code, message, ...)` for failure.
`ts/src/runner.ts` holds the process runner, timeout enforcement with process-group kill, and output truncation.
`ts/src/tools.ts` holds the tool registry mapping each tool name to its handler, the shared fail-closed `runScript`/`ownedCall` path, and deny-list enforcement.
`ts/src/auth.ts` holds tier assignments, approval validation, and the JSON-lines audit log with `duration_ms` timing.
`ts/src/server.ts` holds the stdio JSON-RPC server and message dispatcher.
`ts/tests/` holds the hermetic unit and conformance suites; `tests/mcp-adapter.test.sh` runs the fast unit suites.

## Boundary rule

The server may shell to an owning script with a safe flag subset.
It may not reimplement script behavior, invent flags, touch repos directly, control daemons, or reach any surface in `DENY_LIST`.
`DENY_LIST` covers code-writing and landing tools (`promote_scout`, `teardown_crew`, `arm_pr_check`, `merge_pr`, `merge_local`), daemon and supervision control (`daemon_start/stop/restart`, `watch_start/stop`), local branch merging (`repo_merge`), un-gated public relay emission and linking (`public_followup_emit`, `relay_link`), fleet synchronization and inactive outcome reconciliation (`fleet_sync`, `inactive_reconcile`), remote backlog outbox receipt (`backlog_receive`), session launch/lifecycle machinery (`session_start`, `sessionstart_run`, `sessionstart_cursor`, `herdr_lab`, `herdr_ci_cleanup`, `session_cleanup`, `claude_trust`, `agy_trust`, `claude_stop_autoarm`, `herdr_eventwait`, `herdr_workspace_move`, `backend_select`, covering the sourced `backends/*.sh` provider adapters), every cross-machine remote verb (`on_execute`, `config_push`, `remote_entrypoint`, `remote_herdr_guard`, `remote_provision`, `remote_seed`, `inherit_push`, `remote_inherit`, `reap_orphans`, `remote_worker`), and every installs mutator (`bootstrap`, `check_register`, `check_unregister`, `agents_md_ensure`, `install_actionlint`, `install_herdr`, `install_shellcheck`, `install_treehouse`, `update`, `workflow_lint`): the doorway never reaches, provisions, pushes to, launches on, controls beyond the closed subset, reaps another machine, installs software, seeds homes, bootstraps projects, updates the fleet, or runs lint/test suites.
Denied and unknown tools are refused before any process starts, and validation rejections fire before any side effect. Since 2026-09-22 the server refuses this set itself (`FORBIDDEN_TOOLS`, `ts/src/auth.ts`), so this list is defence in depth rather than the only guard — the agent's own delivery chain (`repo_edit`, `repo_commit`, `repo_push`, `pr_open`) is Tier 3 and deliberately callable.
`runScript` additionally refuses any script outside the registry allow-list, so a bad table entry fails closed.
Denied argv flags (`--key`, `--raw`, `--force`, `--yes`, `--force-with-lease`) can never be emitted by a builder.

## Authorization tiers

Reads (`fleet_snapshot`, `backlog`, `crew_state`, `status_tail`, `fleet_poll`, `peek`, `fleet_view`, `review_diff`, `bearings_snapshot`, `wake_drain`, `guard_check`, `remote_doctor`, `remote_file`, `remote_delta`, `extension_list`, `extension_inspect`, `handoff_status`, `harness_detect`, `project_mode`, `lock_status`, `lease_check`, `bearings_board_path`, `inbox_status`, `inbox_list`, `home_summary`, `home_summary_refresh`, `contributions_snapshot`, `contributions_pending`, `mail_status`, `mail_read`, `mail_check`, `voice_status`, `lint_versions`, `tool_update_check`, `vendor_auth_probe`, `startup_memory`, `startup_network_report`, `doc_audience_check`, `home_seed_validate`, `stow_cascade`, `test_isolation_list`, `test_run_list`, `pr_state`, `pr_poll`, `relay_poll`, `public_followup_pending`, `public_followup_collect`, `tasks_list`, `tasks_show`, `tasks_ready`, `receipt_submit`, `receipt_status`) and the single safe steer (`send_message`, plain prose, 500-char single line, slash commands refused) need no approval.
Every authority-bearing or externally visible tool requires an explicit `approval` string starting with `I authorize`.
Relay sends stay inert without relay consent inside the owning scripts, and downstream code work stays under merge authority, yolo posture, and the decision-hold lifecycle.

## Test

Run `cd ts && bun run test:bun` (or `npm test`) for the full suite, or `bash tests/mcp-adapter.test.sh` for the fast boundary suite.
