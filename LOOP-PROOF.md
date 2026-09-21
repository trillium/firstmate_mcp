# LOOP-PROOF — Observed Autonomous MCP Loop Execution

Generated 2026-09-21T06:33:31Z by `python3 scripts/fm-mcp-loop.py` against a dedicated scratch home (`/tmp/fm-mcp-loop-scratch`).
The live fleet was never touched; all operations ran inside a disposable scratch workspace under a revocable standing approval grant.

## Executive Summary

- **Autonomy Proven**: Full end-to-end MCP workflow executed unattended without a single interactive human approval string (`I authorize ...`).
- **Standing Grant**: Minted scoped grant `grant-81e91d82464984ab` (ref: `884b404cbcc7dd31`, tier limit: 3, TTL: 3600s, max uses: 50).
- **Workflow Scope**: Scout discovery read chain (6 Tier-1 reads) → Tier-2 plain-text steer (`send_message`) → Tier-3 authority writes (`scaffold_brief`, `secondmate_report`) → async detached execution (`receipt_submit` / `receipt_status`) → attestation (`decision_verify`) → durable outcome record bead.
- **Audit Proof**: `19` audit lines logged with complete schema parity; every granted authority action recorded `884b404cbcc7dd31` as `approval_ref`.
- **Kill-Switch Proven**: Mid-run grant revocation demonstrated instant fail-closed refusal (`refuse / approval-invalid`, `detail: grant-revoked`).

## Step-by-Step Execution Log

| # | Phase | Tool | Tier | Status | Duration | Summary / Payload |
|---|---|---|---|---|---|---|
| 1 | BOOTSTRAP | `grant_mint` | Tier 3 | **OK** | 156ms | Minted grant grant-81e91d82464984ab (ref=884b404cbcc7dd31, tier_limit=3, ttl=3600s, max_uses=50) |
| 2 | HANDSHAKE | `initialize` | n/a | **OK** | 133ms | Server firstmate-mcp-poc v0.3.0 protocol=2024-11-05 |
| 3 | DISCOVERY | `tools/list` | n/a | **OK** | 1ms | Discovered 87 registered MCP tools |
| 4 | GRANT_CHECK | `grant_status` | Tier 1 | **VERIFIED** | 1ms | Grant grant-81e91d82464984ab valid=True, is_expired=False, is_revoked=False, uses=0/50 |
| 5 | SCOUT_READ | `fleet_snapshot` | Tier 1 | **PASSED** | 154ms | schema=fm-fleet-snapshot.v1 |
| 6 | SCOUT_READ | `backlog` | Tier 1 | **PASSED** | 6ms | tasks=2 |
| 7 | SCOUT_READ | `crew_state` | Tier 1 | **PASSED** | 123ms | state=running |
| 8 | SCOUT_READ | `status_tail` | Tier 1 | **PASSED** | 1ms | events=3 |
| 9 | SCOUT_READ | `bearings_snapshot` | Tier 1 | **PASSED** | 120ms | schema=fm-bearings.v1 |
| 10 | SCOUT_READ | `guard_check` | Tier 1 | **PASSED** | 130ms | stdout=ok: system guard check nominal (scratch-safe) |
| 11 | STEER | `send_message` | Tier 2 | **PASSED** | 126ms | Steered scout-01 (delivered=True, chars=58) |
| 12 | AUTHORITY_WRITE | `scaffold_brief` | Tier 3 | **PASSED** | 119ms | Scaffolded scout brief under standing grant (stdout: 'mcp-loop: scaffolded brief for task scout-01 (project demo-project, mode --scout)') |
| 13 | AUTHORITY_WRITE | `secondmate_report` | Tier 3 | **PASSED** | 126ms | Secondmate report recorded under standing grant (stdout: 'mcp-loop: secondmate report verb=scout_summary corr=0123456789abcdef note=Scout scan complete: all bearings nominal, 0 drift, ready for next phase') |
| 14 | RECEIPT_SUBMIT | `receipt_submit` | Tier 1 -> 3 | **PENDING** | 2ms | Detached async scaffold_brief -> receipt_id=rcpt-f65d99b266cfcdec (ttl=3600s) |
| 15 | RECEIPT_POLL | `receipt_status` | Tier 1 | **DONE** | 0ms | Receipt rcpt-f65d99b266cfcdec reached terminal state 'done' (poll=1, exit=None) |
| 16 | ATTESTATION | `decision_verify` | Tier 1 | **VERIFIED** | 125ms | Attestation verified for origin_id=scout-01 (verified=True) |
| 17 | OUTCOME_RECORD | `state_write` | Local | **WRITTEN** | - | Wrote durable outcome record bead to mcp-loop-outcome.json |
| 18 | GRANT_STATUS | `grant_status` | Tier 1 | **VERIFIED** | 0ms | Standing grant use count: 4/50 (valid=True) |
| 19 | KILL_SWITCH_PRE | `scaffold_brief` | Tier 3 | **ALLOWED** | 138ms | Pre-revocation call allowed under active grant grant-259e356fdb709a5e (ref=57239f43e97fc2e4) |
| 20 | KILL_SWITCH_ACTION | `grant_revoke` | Tier 3 | **REVOKED** | 1ms | Grant grant-259e356fdb709a5e revoked by supervisor: 'supervisor emergency kill-switch engaged' |
| 21 | KILL_SWITCH_POST | `scaffold_brief` | Tier 3 | **REFUSED** | 1ms | Post-revocation call immediately refused: error='approval required', detail='grant-revoked' |
| 22 | AUDIT_VERIFY | `mcp-audit.jsonl` | Audit | **PASSED** | - | Verified 19 audit records (14 autonomous, 2 Tier-3 granted, 0 leaks, 0 secret tokens) |

## Where the Grant Sufficed vs Where It Would Have Stalled

| Tool Call | Tier | Standing Grant Posture | Without Grant (Default-Deny) | Autonomous Result |
|---|---|---|---|---|
| `fleet_snapshot`, `backlog`, `crew_state`, etc. | Tier 1 | Open Read | Open Read (Allowed) | **Allowed** without approval |
| `send_message` | Tier 2 | Reversible Steer | Validated Text (Allowed) | **Allowed** without approval |
| `scaffold_brief` | Tier 3 | Scoped in Grant (`tools: [...]`) | Refused (`approval required`) | **Allowed autonomously** via grant |
| `secondmate_report` | Tier 3 | Scoped in Grant (`tools: [...]`) | Refused (`approval required`) | **Allowed autonomously** via grant |
| `receipt_submit` (scaffold_brief) | Tier 3 | Scoped in Grant (`tools: [...]`) | Refused (`approval required`) | **Allowed & detached** via grant |
| `decision_resolve` / captain holds | Tier 3 | Excluded from Wildcard | Refused (`approval required`) | **Blocked** (Safety Core intact) |
| `relay_reply` / external sends | Tier 4 | Exceeded Tier Limit (Grant max=3) | Refused (`approval required`) | **Blocked** (Tier boundary intact) |
| `promote_scout`, `teardown_crew` | Forbidden | Never Grantable | Unknown Tool Refused | **Blocked** (Code-forbidden intact) |

## Kill-Switch Proof (Mid-Run Revocation Behavior)

The standing grant kill-switch was actively exercised and verified:
1. Minted demonstration grant `grant-259e356fdb709a5e` (ref: `57239f43e97fc2e4`).
2. Pre-revocation authority write (`scaffold_brief`) succeeded under active grant (`allow/ok`).
3. Supervisor executed `grant_revoke` with reason `supervisor emergency kill-switch engaged`.
4. Post-revocation authority write was **instantly refused** with `refuse/approval-invalid` and `detail: grant-revoked`.
5. Subprocess dispatch was prevented entirely; zero orphan executions occurred.

```json
{
  "grant_id": "grant-259e356fdb709a5e",
  "grant_ref": "57239f43e97fc2e4",
  "pre_revocation_allowed": true,
  "revocation_successful": true,
  "post_revocation_refused": true,
  "refusal_reason": "grant-revoked"
}
```

## Durable Outcome Record Bead

Written to `/tmp/fm-mcp-loop-scratch/state/mcp-loop-outcome.json`:

```json
{
  "schema": "fm-mcp-loop-outcome.v1",
  "timestamp": "2026-09-21T06:33:31Z",
  "actor": "mcp-loopproof",
  "grant_id": "grant-81e91d82464984ab",
  "grant_ref": "884b404cbcc7dd31",
  "steps_executed": 16,
  "scout_findings": {
    "tasks_examined": 2,
    "bearings": "nominal",
    "steer_delivered": true,
    "brief_scaffolded": "scout-01",
    "async_receipt": "rcpt-f65d99b266cfcdec",
    "attestation": "verified"
  },
  "safety_invariants": {
    "human_approval_strings_used": 0,
    "live_fleet_touched": false,
    "landing_or_teardown_attempted": false,
    "grant_boundaries_respected": true
  }
}
```

## Audit Log Trail (`mcp-audit.jsonl`)

Audit log recorded `19` entries with format version 1 and exact field schema:

```json
{"actor":"captain-bootstrap","approval_ref":"ee96eda8b85e52e7","decision":"allow","decision_digest":null,"duration_ms":1,"reason":"ok","target":"mcp-loopproof","tier":3,"tool":"grant_mint","transport":"stdio","ts":"2026-09-21T06:33:30Z","v":1}
{"actor":"mcp-loopproof","approval_ref":null,"decision":"allow","decision_digest":null,"duration_ms":0,"reason":"ok","target":"grant-81e91d82464984ab","tier":1,"tool":"grant_status","transport":"stdio","ts":"2026-09-21T06:33:30Z","v":1}
{"actor":"mcp-loopproof","approval_ref":null,"decision":"allow","decision_digest":null,"duration_ms":142,"reason":"ok","target":null,"tier":1,"tool":"fleet_snapshot","transport":"stdio","ts":"2026-09-21T06:33:30Z","v":1}
{"actor":"mcp-loopproof","approval_ref":null,"decision":"allow","decision_digest":null,"duration_ms":5,"reason":"ok","target":null,"tier":1,"tool":"backlog","transport":"stdio","ts":"2026-09-21T06:33:30Z","v":1}
{"actor":"mcp-loopproof","approval_ref":null,"decision":"allow","decision_digest":null,"duration_ms":122,"reason":"ok","target":"scout-01","tier":1,"tool":"crew_state","transport":"stdio","ts":"2026-09-21T06:33:30Z","v":1}
{"actor":"mcp-loopproof","approval_ref":null,"decision":"allow","decision_digest":null,"duration_ms":0,"reason":"ok","target":"scout-01","tier":1,"tool":"status_tail","transport":"stdio","ts":"2026-09-21T06:33:30Z","v":1}
{"actor":"mcp-loopproof","approval_ref":null,"decision":"allow","decision_digest":null,"duration_ms":120,"reason":"ok","target":null,"tier":1,"tool":"bearings_snapshot","transport":"stdio","ts":"2026-09-21T06:33:30Z","v":1}
{"actor":"mcp-loopproof","approval_ref":null,"decision":"allow","decision_digest":null,"duration_ms":128,"reason":"ok","target":null,"tier":1,"tool":"guard_check","transport":"stdio","ts":"2026-09-21T06:33:30Z","v":1}
{"actor":"mcp-loopproof","approval_ref":null,"decision":"allow","decision_digest":null,"duration_ms":125,"reason":"ok","target":"scout-01","tier":2,"tool":"send_message","transport":"stdio","ts":"2026-09-21T06:33:31Z","v":1}
{"actor":"mcp-loopproof","approval_ref":"884b404cbcc7dd31","decision":"allow","decision_digest":null,"duration_ms":119,"reason":"ok","target":"scout-01","tier":3,"tool":"scaffold_brief","transport":"stdio","ts":"2026-09-21T06:33:31Z","v":1}
{"actor":"mcp-loopproof","approval_ref":"884b404cbcc7dd31","decision":"allow","decision_digest":null,"duration_ms":125,"reason":"ok","target":null,"tier":3,"tool":"secondmate_report","transport":"stdio","ts":"2026-09-21T06:33:31Z","v":1}
{"actor":"mcp-loopproof","approval_ref":null,"decision":"allow","decision_digest":null,"duration_ms":1,"reason":"ok","target":"scaffold_brief","tier":1,"tool":"receipt_submit","transport":"stdio","ts":"2026-09-21T06:33:31Z","v":1}
{"actor":"mcp-loopproof","approval_ref":null,"decision":"allow","decision_digest":null,"duration_ms":0,"reason":"ok","target":"rcpt-f65d99b266cfcdec","tier":1,"tool":"receipt_status","transport":"stdio","ts":"2026-09-21T06:33:31Z","v":1}
{"actor":"mcp-loopproof","approval_ref":null,"decision":"allow","decision_digest":null,"duration_ms":124,"reason":"ok","target":"scout-01","tier":1,"tool":"decision_verify","transport":"stdio","ts":"2026-09-21T06:33:31Z","v":1}
{"actor":"mcp-loopproof","approval_ref":null,"decision":"allow","decision_digest":null,"duration_ms":0,"reason":"ok","target":"grant-81e91d82464984ab","tier":1,"tool":"grant_status","transport":"stdio","ts":"2026-09-21T06:33:31Z","v":1}
{"actor":"captain-bootstrap","approval_ref":"40adf934d698270c","decision":"allow","decision_digest":null,"duration_ms":1,"reason":"ok","target":"kill-switch-worker","tier":3,"tool":"grant_mint","transport":"stdio","ts":"2026-09-21T06:33:31Z","v":1}
{"actor":"kill-switch-worker","approval_ref":"57239f43e97fc2e4","decision":"allow","decision_digest":null,"duration_ms":13,"reason":"ok","target":"kill-demo-1","tier":3,"tool":"scaffold_brief","transport":"stdio","ts":"2026-09-21T06:33:31Z","v":1}
{"actor":"captain-bootstrap","approval_ref":"1de41c9a1299808f","decision":"allow","decision_digest":null,"duration_ms":1,"reason":"ok","target":"grant-259e356fdb709a5e","tier":3,"tool":"grant_revoke","transport":"stdio","ts":"2026-09-21T06:33:31Z","v":1}
{"actor":"kill-switch-worker","approval_ref":null,"decision":"refuse","decision_digest":null,"duration_ms":0,"reason":"approval-required","target":"kill-demo-2","tier":3,"tool":"scaffold_brief","transport":"stdio","ts":"2026-09-21T06:33:31Z","v":1}
```

## Safety & Residual Risk Posture

1. **Default-Deny Preservation**: Calls without approval and without valid grants remain strictly refused.
2. **Secret Token Isolation**: High-entropy tokens (`sg_<hex>`) are hashed on disk (SHA-256) and never appear in audit logs or tool responses.
3. **Cross-Home Sandboxing**: Grants and receipts reside exclusively under `FM_HOME/state/` and cannot leak across checkouts or homes.
4. **Fail-Closed Revocation**: Revoked and expired grants fail closed immediately on the next tool invocation.
