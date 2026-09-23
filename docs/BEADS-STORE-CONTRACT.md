# Beads store contract (project-iptk)

`bin/fm-tasks-axi-lib.sh` (trillium/firstmate, fork-only) is the single owner
of beads store resolution. Every doorway beads read/write must resolve the
store the way this lib does — through the wrapper, never around it.

## The mechanism

1. The `task` wrapper pins `BEADS_DIR` (plus `BD_NAME`) for the whole
   federation. Firstmate never derives, guesses, or hardcodes a store path.
2. `fm_backlog_backend_value` reads `config/backlog-backend` (default
   `tasks-axi`). On `beads`, callers additionally require a `task` CLI on
   PATH whose `task list --limit 1` answers — reachability is a cheap read,
   not a `.beads/` directory check.
3. The idempotency label is home-scoped: `task:<16-hex-sha256-of-FM_HOME>:<id>`
   (`fm_beads_task_label`), because the store is machine-wide while backlogs
   are per-home. Two homes reusing one slug resolve to DIFFERENT beads. The
   shared `fleet:firstmate` label is necessary but not sufficient scoping.
4. `fm_beads_is_closed` is the authoritative completion signal: true ONLY for
   an existing bead with status `closed`. Absent/open/unreadable is not
   closed — reconciliation falls through instead of inventing completion.

## Ownership boundary

Doorway-consumable as contract (declared in `schema/contracts.yaml` as
`beads_backend`, `beads_scope`, `beads_is_closed`):

- backend selection + reachability probes
- fleet label, home scope, task-label derivation
- bounded single-bead status read + closed predicate

Firstmate-private, stays out:

- `fm_beads_resolve_or_create` / `fm_beads_mint_task_bead` (mutation)
- `fm_beads_migrate_legacy_task_labels*` (one-shot sweep, session-locked)
- `fm_beads_claims_bead`, `fm_beads_home_repoint_recorded_bead` (claims)
- bootstrap/sync plumbing (`fm_beads_bootstrap_store`, `fm_beads_sync_*`)
- `fm_beads_close_already_applied` (resilience lib: absent means applied —
  the opposite convention from `is_closed`, deliberately, for queue replay)

## Proof

Two-home scoping fixture (same slug, two homes → two beads): conformance
suite, `task-8pqjb`-style fail-first. Until it lands, the invariant is
doctrine, not proof.
