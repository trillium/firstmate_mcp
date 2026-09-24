/**
 * Tier/approval/forbidden tables + names. (slice 23 of the auth.ts folder split, task-8pqjb; pattern: brain-ws6lr).
 *
 * Moved verbatim from src/auth.ts. Exported there, re-exported via
 * auth.ts so the `./auth.js` public surface is unchanged.
 */


export const APPROVAL_PREFIX = "I authorize";
export const APPROVAL_MAX_CHARS = 500;

export const TIER_OPEN = 1;
export const TIER_STEER = 2;
export const TIER_AUTHORITY = 3;
export const TIER_EXTERNAL = 4;
export const TIER_FORBIDDEN = "forbidden" as const;

export type Tier = 1 | 2 | 3 | 4 | "forbidden";

export const TOOL_TIERS: Record<string, Tier> = {
  fleet_snapshot: TIER_OPEN,
  backlog: TIER_OPEN,
  crew_state: TIER_OPEN,
  status_tail: TIER_OPEN,
  fleet_poll: TIER_OPEN,
  peek: TIER_OPEN,
  fleet_view: TIER_OPEN,
  review_diff: TIER_OPEN,
  bearings_snapshot: TIER_OPEN,
  wake_drain: TIER_OPEN,
  guard_check: TIER_OPEN,
  remote_doctor: TIER_OPEN,
  remote_file: TIER_OPEN,
  remote_delta: TIER_OPEN,
  handoff_status: TIER_OPEN,
  harness_detect: TIER_OPEN,
  project_mode: TIER_OPEN,
  lock_status: TIER_OPEN,
  lease_check: TIER_OPEN,
  bearings_board_path: TIER_OPEN,
  inbox_status: TIER_OPEN,
  inbox_list: TIER_OPEN,
  home_summary: TIER_OPEN,
  home_summary_refresh: TIER_OPEN,
  contributions_snapshot: TIER_OPEN,
  contributions_pending: TIER_OPEN,
  mail_status: TIER_OPEN,
  mail_read: TIER_OPEN,
  mail_check: TIER_OPEN,
  voice_status: TIER_OPEN,
  doctor: TIER_OPEN,
  lint_versions: TIER_OPEN,
  tool_update_check: TIER_OPEN,
  vendor_auth_probe: TIER_OPEN,
  startup_memory: TIER_OPEN,
  pr_state: TIER_OPEN,
  pr_poll: TIER_OPEN,
  pr_reviewers: TIER_OPEN,
  // The write counterpart of the PR reads: opens a pull request for an
  // already-pushed branch. merge_pr stays forbidden by design, so this is the
  // last step an agent may take on its own.
  pr_open: TIER_AUTHORITY,
  arm_policy_check: TIER_OPEN,
  cd_policy_check: TIER_OPEN,
  subagent_policy_check: TIER_OPEN,
  supervision_instructions: TIER_OPEN,
  quota_choose: TIER_OPEN,
  relay_poll: TIER_OPEN,
  public_followup_pending: TIER_OPEN,
  public_followup_collect: TIER_OPEN,
  tasks_list: TIER_OPEN,
  tasks_show: TIER_OPEN,
  tasks_ready: TIER_OPEN,
  dispatch_resolve: TIER_OPEN,
  sessionstart_nudge: TIER_OPEN,
  extension_list: TIER_OPEN,
  extension_inspect: TIER_OPEN,
  startup_network_report: TIER_OPEN,
  doc_audience_check: TIER_OPEN,
  home_seed_validate: TIER_OPEN,
  stow_cascade: TIER_OPEN,
  test_isolation_list: TIER_OPEN,
  test_run_list: TIER_OPEN,
  // Running the suite executes repo code with the server's privileges and takes
  // minutes, so it is an authority action rather than a read; the reads above
  // deliberately keep suite runs out.
  test_run: TIER_AUTHORITY,
  receipt_submit: TIER_OPEN,
  receipt_status: TIER_OPEN,
  send_message: TIER_STEER,
  lifecycle_interrupt: TIER_AUTHORITY,
  lifecycle_exit: TIER_AUTHORITY,
  lifecycle_relaunch: TIER_AUTHORITY,
  lifecycle_suspend: TIER_AUTHORITY,
  lifecycle_resume: TIER_AUTHORITY,
  spawn_crew: TIER_AUTHORITY,
  scaffold_brief: TIER_AUTHORITY,
  decision_hold: TIER_AUTHORITY,
  decision_resolve: TIER_AUTHORITY,
  decision_release: TIER_AUTHORITY,
  decision_complete: TIER_AUTHORITY,
  decision_verify: TIER_OPEN,
  decision_open: TIER_OPEN,
  decision_diverged: TIER_OPEN,
  review_decision: TIER_AUTHORITY,
  secondmate_nudge: TIER_AUTHORITY,
  secondmate_restart: TIER_AUTHORITY,
  secondmate_report: TIER_AUTHORITY,
  remote_control: TIER_AUTHORITY,
  handoff_move: TIER_AUTHORITY,
  voice_queue: TIER_AUTHORITY,
  repo_edit: TIER_AUTHORITY,
  repo_commit: TIER_AUTHORITY,
  repo_push: TIER_AUTHORITY,
  daemon_status: TIER_OPEN,
  task_intake: TIER_AUTHORITY,
  worktree_allocate: TIER_AUTHORITY,
  lifecycle_drive: TIER_AUTHORITY,
  review_gate: TIER_AUTHORITY,
  reconcile_upstream: TIER_AUTHORITY,
  afk_contract: TIER_AUTHORITY,
  afk_launch: TIER_AUTHORITY,
  afk_return: TIER_AUTHORITY,
  afk_start: TIER_AUTHORITY,
  branch_outcome: TIER_AUTHORITY,
  branch_prompt: TIER_AUTHORITY,
  busy_event: TIER_AUTHORITY,
  kimi_turnend_hook: TIER_AUTHORITY,
  operational_input: TIER_AUTHORITY,
  procevent_run: TIER_AUTHORITY,
  procevent_lavish: TIER_AUTHORITY,
  procevent_quota: TIER_AUTHORITY,
  procevent_remote_reply: TIER_AUTHORITY,
  procevent_when: TIER_AUTHORITY,
  turnend_guard: TIER_AUTHORITY,
  turnend_guard_cursor: TIER_AUTHORITY,
  turnend_guard_grok: TIER_AUTHORITY,
  wake_grant: TIER_AUTHORITY,
  watch_checkpoint: TIER_AUTHORITY,
  mail_send: TIER_EXTERNAL,
  relay_reply: TIER_EXTERNAL,
  relay_dismiss: TIER_EXTERNAL,
  relay_followup: TIER_EXTERNAL,
  grant_mint: TIER_AUTHORITY,
  grant_revoke: TIER_AUTHORITY,
  grant_status: TIER_OPEN,
  promote_scout: TIER_AUTHORITY,
  arm_pr_check: TIER_AUTHORITY,
  beads_mirror: TIER_OPEN,
  beads_queue: TIER_OPEN,
  ledger_list: TIER_OPEN,
  reap_triage: TIER_OPEN,
  coderabbit_state: TIER_OPEN,
  git_history: TIER_OPEN,
  git_blame: TIER_OPEN,
  ci_history: TIER_OPEN,
  fleet_ledger: TIER_OPEN,
  devin_config: TIER_AUTHORITY,
  fork_origin_check: TIER_OPEN,
  beads_backup: TIER_OPEN,
  backlog_import: TIER_AUTHORITY,
};

/**
 * Code-forbidden tools: refused by the server itself, with no approval string and
 * no standing grant able to authorize them.
 *
 * This list was empty while AUTH.md, this file's header, and
 * docs/mcp-adapter.md all documented these surfaces as denied, and `tierOf`
 * consulted TOOL_TIERS first — so a stale tier entry shadowed the list entirely
 * and every one of these was reachable with an approval string (filed as
 * project-2od.20, proven by calling merge_pr's tier through the dispatcher).
 *
 * Deliberately NOT here: the agent's own delivery chain. `repo_edit`,
 * `repo_commit`, `repo_push` and `pr_open` are Tier 3 authority writes, because
 * landing work through the doorway is the point of the doorway (autonomy gap 1).
 * `repo_merge` IS here: merging into a default branch locally bypasses the pull
 * request the chain exists to open.
 */
export const FORBIDDEN_TOOLS: readonly string[] = [
  // Code-writing and landing surfaces the captain keeps
  "teardown_crew",
  "merge_pr",
  "merge_local",
  "repo_merge",
  // Daemon and supervision control
  "daemon_start",
  "daemon_stop",
  "daemon_restart",
  "watch_start",
  "watch_stop",
  // Un-gated public emission, fleet sync, cross-home receipt
  "public_followup_emit",
  "relay_link",
  "fleet_sync",
  "inactive_reconcile",
  "backlog_receive",
  // Session launch and lifecycle machinery
  "session_start",
  "sessionstart_run",
  "sessionstart_cursor",
  "herdr_lab",
  "herdr_ci_cleanup",
  "session_cleanup",
  "claude_trust",
  "agy_trust",
  "claude_stop_autoarm",
  "herdr_eventwait",
  "herdr_workspace_move",
  "backend_select",
  // Cross-machine verbs
  "on_execute",
  "config_push",
  "remote_entrypoint",
  "remote_herdr_guard",
  "remote_provision",
  "remote_seed",
  "inherit_push",
  "remote_inherit",
  "reap_orphans",
  "remote_worker",
  // Installs mutators
  "bootstrap",
  "check_register",
  "check_unregister",
  "agents_md_ensure",
  "install_actionlint",
  "install_herdr",
  "install_shellcheck",
  "install_treehouse",
  "update",
  "workflow_lint",
  // External-agent wake bridge: blocks on a live event stream and writes the
  // shared wake queue; supervision continuity belongs to the watcher alone
  "herdr_spur",
] as const;

export const TIER_NAMES: Record<string, string> = {
  [TIER_OPEN]: "open reads",
  [TIER_STEER]: "reversible steers",
  [TIER_AUTHORITY]: "authority writes",
  [TIER_EXTERNAL]: "external sends",
  [TIER_FORBIDDEN]: "code-forbidden",
};
