First Mate MCP authorization tiers (smarts-only)

Trillium is the sole authorizer under the owner-ordered smarts-only line of 2026-09-13.
Every authority-bearing or externally visible tool takes an explicit `approval` string starting with `I authorize` and refuses without it.
Reads stay open because they change nothing.
Tier 1 - open reads (no approval): `fleet_snapshot`, `backlog`, `crew_state`, `status_tail`, `fleet_poll`, `peek`, `fleet_view`, `review_diff`, `bearings_snapshot`, `wake_drain`, `guard_check`, `remote_doctor`, `remote_file`, `remote_delta`, `handoff_status`, `harness_detect`, `project_mode`, `lock_status`, `lease_check`, `bearings_board_path`, `inbox_status`, `inbox_list`, `home_summary`, `home_summary_refresh`, `contributions_snapshot`, `contributions_pending`, `mail_status`, `mail_read`, `mail_check`, `voice_status`, `lint_versions`, `tool_update_check`, `vendor_auth_probe`, `startup_memory`, `pr_state`, `relay_poll`, `public_followup_pending`, `public_followup_collect`, `receipt_submit`, `receipt_status`, `grant_status`, `decision_verify`, `decision_open`, `decision_diverged`.
`remote_doctor` runs check mode only (no `--fix`); `remote_file` is get-only with a bounded byte cap; `remote_delta` clamps its wait to 10s; `handoff_status` reads staged outbox files only.
`harness_detect` runs a closed detection-mode subset (no ancestry walks); `project_mode` reports the mapped mode+yolo pair (no `--raw`); `lock_status` and `lease_check` are status reads only (no acquire, claim, release, or sweep); `bearings_board_path` prints the stable board path (no build/arm); `inbox_status`/`inbox_list` read durable records only (no queue, wake, or model call); `home_summary` reads the published ledger (no refresh); `contributions_snapshot`/`contributions_pending` never contact a forge and mutate nothing.
`mail_status` prints config plus cursor (no network, no wake); `mail_read` is a BODY.PEEK digest that never marks mail seen; `mail_check` runs the bounded inbound received-mail check (arm/disarm mutate watcher trust state and stay out); all stay inert without mail credentials, which live outside MCP in the home `.env` and never cross tool args or logs; `voice_status` reads durable records only (counts by default, no record free text; full only via the captain's own read-scope, deny list enforced inside the helper; no mic, no Bedrock, no audio); `lint_versions` prints the required ShellCheck/actionlint pins only; `tool_update_check` reports only (repairs/installs nothing); `vendor_auth_probe` runs one bounded probe from the closed allowlist and prints one sanitized line (raw vendor output never leaves the script); `startup_memory` reads the validated budget or local estimate (never creates config); `pr_state` is a one-shot blockers read over a validated GitHub PR URL (never posts); `relay_poll` is a short bounded poll that is a hard no-op without relay consent; `public_followup_pending` reads open public commitments for the session-start digest (never mutates registry or delivers replies); `public_followup_collect` runs non-destructive `drain <obligation-id>` on staged outbox events waiting in the outbox (`drop`/retire stays firstmate-owned).
`receipt_submit` detaches one tool call past the 30s fail-closed budget and returns a pending receipt; authority targets still need their own nested approval string. `receipt_status` reports running/done/failed for one receipt.
Tier 2 - reversible steers (no approval, validated text): `send_message` wraps only the plain-text `fm-send.sh` path with a 500-char single-line cap and a slash-command refusal.
Tier 3 - launch-authorized writes (approval required): `lifecycle_interrupt`, `lifecycle_exit`, `lifecycle_relaunch`, `lifecycle_suspend`, `lifecycle_resume`, `spawn_crew`, `scaffold_brief`, `decision_hold`, `decision_resolve`, `decision_release`, `decision_complete`, `review_decision`, `secondmate_nudge`, `secondmate_restart`, `secondmate_report`, `remote_control`, `handoff_move`, `voice_queue`, `grant_mint`, `grant_revoke`.
Lifecycle verbs are launch control only: they drive agent lifecycle and never touch repos directly.
Decision-closing verbs (`decision_resolve`, `decision_release`, `review_decision` with `--release`, and `decision_complete`) enforce the SAFETY CORE:
- Default scope: allows releasing/resolving ONLY holds the calling agent opened itself (matching invoking actor to hold author/origin metadata).
- Captain-opened or third-party holds refuse unless an explicit per-deploy release grant (`FM_RELEASE_GRANT=1`, default OFF) is configured in the server environment.
- Mandatory linked decision record: releases without a non-empty durable decision record refuse.
- Audit accountability: every release and resolve call records the SHA-256 `decision_digest` in the audit log.
- Attestation tools (`decision_verify`, `decision_open`, `decision_diverged`) provide structured read paths for agent verification of hold state, lifecycle identities, and record divergence without mutations.
Secondmate/remote verbs carry the same safe-subset discipline: `secondmate_nudge` is notify-only, `secondmate_restart` takes ids only, `secondmate_report` is the note-only form with the destination resolved by the owning helper, `remote_control` is the closed state/route/observe/send subset (no launch, no raw pane access, no remote teardown), and `handoff_move` moves only queued items or resumes pending wakes. Provisioning new secondmate homes stays out (firstmate-owned) unless read-only status.
`spawn_crew` and `scaffold_brief` carry only the safe subset of flags with no repo-mutation options.
`voice_queue` hands one single-line request to firstmate through the handover queue (no microphone, no audio, no Bedrock session; the mic client and the Bedrock relay have no tool — mic hardware and AWS credentials stay out of MCP).
Downstream code work stays under the owning scripts with merge authority, yolo posture, and decision-hold lifecycle.
Tier 4 - external sends (approval required, relay-gated): `relay_reply`, `relay_dismiss`, `relay_followup`, `mail_send` shell to the owning `fm-x-*.sh` / `fm-mail.sh` scripts and stay inert without relay/mail consent.
`mail_send` carries a validated to/subject plus a body piped via stdin (never in argv, never logged); SMTP credentials live outside MCP in the home `.env`.
Code-forbidden (no tool, refused as unknown): `promote_scout`, `teardown_crew`, `arm_pr_check`, `merge_pr`, `merge_local`, `public_followup_emit`, `relay_link`, `fleet_sync`, `inactive_reconcile`.
No edit, commit, merge, or PR tools exist in this layer.
No direct repo mutation paths exist in this layer.
No teardown that discards work exists in this layer.
No promote-to-ship paths exist in this layer.

Audit log format:
Every allow and every refuse appends exactly one JSON object per line.
Each line carries these keys: `v` (format version, currently 1), `ts` (UTC `YYYY-MM-DDTHH:MM:SSZ`), `actor` (invoking identity), `tool` (requested tool name), `tier` (1, 2, 3, 4, `forbidden`, or null when unknown), `decision` (`allow` or `refuse`), `reason` (`ok`, `approval-required`, `approval-invalid`, `validation-failed`, `unknown-tool`, or `forbidden`), `approval_ref` (16 hex chars of the token hash, or null when no token was presented), `target` (primary id or null), `duration_ms` (integer execution time in ms from call start to envelope close, or null), `transport` (`"stdio"` or `"http"`), and `decision_digest` (SHA-256 hex digest of the durable decision record for release/resolve tools, or null).
Example: `{"actor": "local", "approval_ref": null, "decision": "allow", "decision_digest": null, "duration_ms": 142, "reason": "ok", "target": null, "tier": 1, "tool": "fleet_snapshot", "transport": "stdio", "ts": "2026-09-19T10:00:00Z", "v": 1}`.

Streamable HTTP transport (AUDIT control plane):
An additive Streamable HTTP transport exists alongside stdio so external audit systems can inspect fleet states, crew states, audit trails, guard checks, bearings, and receipts over HTTP (JSON-RPC / SSE stream) without operating the fleet.
1. Localhost-first binding: Binds to `127.0.0.1` by default; stdio remains untouched and default.
2. Origin & Host validation: Strict DNS-rebinding and CSRF mitigation. Rejects non-localhost/unapproved `Origin` and `Host` headers with `403 Forbidden`.
3. Authentication mechanism: Requires an RFC 6750 Bearer token in the `Authorization` header (`Authorization: Bearer <token>`). Tokens are verified in constant time (`crypto.timingSafeEqual`) to prevent side-channel timing leaks. Bearer token auth was chosen because:
   - It is the standard authentication model for HTTP API / MCP transports.
   - Tokens reside exclusively in HTTP headers and are never leaked via URLs, query strings, or browser histories.
   - Immune to ambient browser credential attacks (unlike cookies); combined with Origin and Host header validation, this provides defense-in-depth against CSRF, DNS rebinding, and unauthorized intranet reach-in.
   - Programmatic audit clients, proxies, and monitoring systems natively support Authorization headers.
4. MCP Spec Session handling: `Mcp-Session-Id` header lifecycle, session store with TTL expiry, and `DELETE /mcp` termination.
5. Auth Tier Parity: Does not widen any write permissions. The exact same tiers, per-action `I authorize` approvals, and deny posture apply identically over HTTP.

Standing approval grants (AUTONOMY control plane):
To enable autonomous worker loops without human stall at every authorization gate while strictly preserving refusal-biased safety invariants, a scoped standing approval primitive is implemented in `ts/src/grants.ts`:
1. Minting & Scoped Grants (`grant_mint`):
   - Authority-gated Tier 3 write requiring explicit per-action approval ("I authorize ...").
   - Mints a scoped standing grant with tier limits (1..4, default 3), tool allowlists, project scopes, expiry TTL (`ttl_s`), and optional usage limits (`max_uses`).
   - Generates high-entropy secret token (`sg_<hex>`) returned ONCE at mint time.
   - On-disk storage (`state/mcp-grants/<grant_id>.json`) stores only `token_hash` (SHA-256) and `grant_ref` (16-hex short hash). Plaintext tokens are NEVER stored on disk, logged in audit files, or exposed.
2. Presentation & Authorization Flow:
   - Callers can provide standing grant tokens via `args.grant`, `args.approval` (starts with `sg_` or `grant:`), or ambient `FM_STANDING_GRANT` environment variable.
   - If a valid grant is provided within its allowed scope (tier, tool, project, non-expired, non-revoked, non-exhausted), the call passes the approval gate without per-action approval strings.
   - `args._grant_ref` is captured and recorded as `approval_ref` (16 hex chars hash) in the audit log.
3. Revocation & Inspection (`grant_revoke`, `grant_status`):
   - `grant_revoke`: Tier 3 authority write to immediately revoke a grant by `grant_id` or `grant_ref`. Revoked grants fail closed immediately.
   - `grant_status`: Tier 1 open read to inspect grant metadata (validity, expiry, usage count, scopes). Strictly returns safe metadata; never reveals secret tokens or hashes.
4. Refusal-Biased Security Invariants:
   - Default-Deny: Calls without approval strings and without valid standing grants are strictly refused (`approval required`).
   - Captain-Hold Release Protection: Wildcard grants (`tools: null` or `tools: ["*"]`) NEVER authorize captain-hold release tools (`review_decision`, `decision_resolve`). Releasing a captain-held task requires an explicit per-deploy grant specifically naming the tool in its allowlist.
   - Deny-List Preservation: Code-forbidden tools (`promote_scout`, `teardown_crew`, `arm_pr_check`, `merge_pr`, `merge_local`, `repo_*`, `daemon_start/stop/restart`, `watch_start/stop`) remain refused as unknown tools and can never be granted.
   - Tier Boundaries: Grants never widen tiers (e.g. a Tier 3 grant attempting a Tier 4 external send is strictly refused with `grant-tier-exceeded`).
   - Fail-Closed Expiry & Revocation: Expired, revoked, and exhausted grants fail closed immediately.
   - Cross-Home Isolation: Grants live under `FM_HOME/state/mcp-grants/` and never leak across home sandboxes.

Safety notes that survive the smarts-only trim.
The MCP layer never reimplements policy: every tool shells to the owning `bin/` script and the script still fails closed.
Relay sends still require relay consent (`FMX_PAIRING_TOKEN`) and follow-up budgets inside the owning scripts.
`FM_HOME` is inherited from the server environment, so pin it at launch and do not expose it as a tool argument.
