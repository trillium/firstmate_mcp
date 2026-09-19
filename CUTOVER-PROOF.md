# CUTOVER-PROOF — live fleet through firstmate_mcp

Generated 2026-09-19T21:17:06Z by `python3 scripts/cutover_prove.py` against a
scratch home only (`/tmp/fm-mcp-cutover-proof`). The live fleet
was never touched.

Launcher: `scripts/fm-mcp-launch.sh --home $SCRATCH`
pins one `FM_HOME`, stays local-only (stdio JSON-RPC, no TCP/SSE),
and execs the TypeScript server with the `I authorize` approval flow
and the JSON-lines audit log (`$FM_HOME/state/mcp-audit.jsonl`).

TS banner: `fm-mcp-launch: home=/tmp/fm-mcp-cutover-proof server=ts audit=/tmp/fm-mcp-cutover-proof/state/mcp-audit.jsonl actor=cutover-proof transport=stdio-local-only`

## Read sweep + steers (TypeScript server, scratch home)

| tool | approval | result | detail |
|---|---|---|---|
| `initialize/tools/list` | n/a | **ok** | 57 tools, server firstmate-mcp-poc 0.3.0 |
| `fleet_snapshot` | none (Tier 1) | **ok** | schema=fm-fleet-snapshot.v1 tasks=2 |
| `backlog` | none (Tier 1) | **ok** | total=2 |
| `crew_state` | none (Tier 1) | **ok** | state=running |
| `status_tail` | none (Tier 1) | **ok** | events=3 |
| `fleet_poll` | none (Tier 1) | **ok** | polls=1 |
| `send_message` | none (Tier 2) | **ok** | delivered=True |
| `lifecycle_interrupt` | `I authorize` (Tier 3) | **ok** | stdout='cutover-proof: demo-1 interrupt\n' |
| `lifecycle_interrupt` | missing (Tier 3) | **refused** | error='approval required' |
| `relay_reply` | `I authorize` (Tier 4) | **inert** | exit=3 (no FMX_PAIRING_TOKEN) |
| `promote_scout` | n/a (code-forbidden) | **unknown-tool** | unknown tool: promote_scout |

## Approval flow

- Allow: `lifecycle_interrupt` with `I authorize lifecycle_interrupt on demo-1 (cutover proof)` dispatched to the
  owning script and returned its output; audit `allow/ok` (Tier 3).
- Refuse: the same call without `approval` was refused with
  `approval required`; audit `refuse/approval-required`, nothing dispatched.
- Tier 2 `send_message` stays approval-free with validated text;
  Tiers 3/4 refuse without the string per AUTH.md.

## Relay consent (outside this layer)

- `relay_reply` with approval but without `FMX_PAIRING_TOKEN` failed
  closed (exit 3, consent message on stderr): the send stayed inert,
  proving consent still lives in the owning script (FINDINGS.md).

## Code-forbidden

- `promote_scout` answered `unknown tool`, auditing
  `refuse/unknown-tool` at tier `forbidden`: no merge authority lives
  in this layer.

## Audit log (TypeScript server, 10 tools/call lines)

Decisions in order: allow/ok, allow/ok, allow/ok, allow/ok, allow/ok, allow/ok, allow/ok, refuse/approval-required, allow/ok, refuse/unknown-tool.
`approval_ref` is set only on the two calls that presented approval;
the token text never appears in the log (hash only). Full lines:

```json
{"actor":"cutover-proof","approval_ref":null,"decision":"allow","duration_ms":224,"reason":"ok","target":null,"tier":1,"tool":"fleet_snapshot","ts":"2026-09-19T21:17:06Z","v":1}
{"actor":"cutover-proof","approval_ref":null,"decision":"allow","duration_ms":6,"reason":"ok","target":null,"tier":1,"tool":"backlog","ts":"2026-09-19T21:17:06Z","v":1}
{"actor":"cutover-proof","approval_ref":null,"decision":"allow","duration_ms":193,"reason":"ok","target":"demo-1","tier":1,"tool":"crew_state","ts":"2026-09-19T21:17:06Z","v":1}
{"actor":"cutover-proof","approval_ref":null,"decision":"allow","duration_ms":0,"reason":"ok","target":"demo-1","tier":1,"tool":"status_tail","ts":"2026-09-19T21:17:06Z","v":1}
{"actor":"cutover-proof","approval_ref":null,"decision":"allow","duration_ms":6,"reason":"ok","target":null,"tier":1,"tool":"fleet_poll","ts":"2026-09-19T21:17:06Z","v":1}
{"actor":"cutover-proof","approval_ref":null,"decision":"allow","duration_ms":192,"reason":"ok","target":"demo-1","tier":2,"tool":"send_message","ts":"2026-09-19T21:17:06Z","v":1}
{"actor":"cutover-proof","approval_ref":"f036c0f72b3af1ea","decision":"allow","duration_ms":199,"reason":"ok","target":"demo-1","tier":3,"tool":"lifecycle_interrupt","ts":"2026-09-19T21:17:06Z","v":1}
{"actor":"cutover-proof","approval_ref":null,"decision":"refuse","duration_ms":0,"reason":"approval-required","target":"demo-1","tier":3,"tool":"lifecycle_interrupt","ts":"2026-09-19T21:17:06Z","v":1}
{"actor":"cutover-proof","approval_ref":"2cd3c30d309da9d6","decision":"allow","duration_ms":195,"reason":"ok","target":"req-1","tier":4,"tool":"relay_reply","ts":"2026-09-19T21:17:06Z","v":1}
{"actor":"cutover-proof","approval_ref":null,"decision":"refuse","duration_ms":0,"reason":"unknown-tool","target":null,"tier":"forbidden","tool":"promote_scout","ts":"2026-09-19T21:17:06Z","v":1}
```

## Residual risks

Authority laundering and relay consent outside this layer remain as
stated in FINDINGS.md: keep this local-only on a pinned `FM_HOME`,
treat approval strings as per-action captain consent, and rescope
before any networked or multi-user wiring.
