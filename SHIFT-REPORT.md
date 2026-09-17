# Upstream shift report (first: 2026-09-17)

First run of `drift/shift.py`: the `sources/firstmate` submodule pin
diffed against current upstream main, mapped onto the depended-on
contracts in `schema/contracts.yaml`. Ported nothing; this report is
the deliverable and ports dispatch separately.

- pinned (gitlink `sources/firstmate`):
  `3eb5b6334a80e06083e3837f0032a5cec39b8e52`
- upstream main (`https://github.com/kunchenguid/firstmate.git`, via
  `git ls-remote HEAD`): `3eb5b6334a80e06083e3837f0032a5cec39b8e52`
- verdict: **no shift** — the pin tracks upstream main
  (`shift.py` exit 0, 0 depended-on moved, 0 other changed).

## PORT (depended-on surfaces that moved)

None. The depended-on script set is unchanged between pin and upstream
main, so there is nothing to port:

| contract | owning script | stability | status |
|---|---|---|---|
| fleet_snapshot | `bin/fm-fleet-snapshot.sh` | stable | unmoved |
| crew_state | `bin/fm-crew-state.sh` | stable | unmoved |
| send_message | `bin/fm-send.sh` | stable | unmoved |
| spawn_crew | `bin/fm-spawn.sh` | evolving | unmoved |
| scaffold_brief | `bin/fm-brief.sh` | evolving | unmoved |
| backlog | derived from fleet_snapshot (no script) | stable | n/a (no `bin/` surface) |
| status_tail | file `state/<id>.status` (no script) | stable | n/a (no `bin/` surface) |

## IGNORE (other changed scripts / noise)

None — `git diff --name-only <pinned> <upstream> -- bin/` is empty.

## Drift-axis cross-check (same day, live checkout)

The Sep-13 drift baseline (`9bf454f4`, 165 surfaces) was refreshed
against the live firstmate checkout (`aaf67489`, 163 surfaces):
0 added, 2 removed (`fm-inbox-watch-supervise.sh`,
`fm-procevent-inbox.sh` — unmerged task-branch experiments, never on
main), 12 changed (3 feature, 12 behavior; only feature change is
`fm-wake-drain.sh` gaining `--yes`). None of the 14 touched surfaces
is depended-on: all five depended-on scripts are snapshot-identical
before/after. Port queue is empty on both axes.

## Repro

```sh
python3 drift/shift.py --format text    # exit 0: pin tracks upstream main
python3 drift/shift.py --format json    # machine-readable summary
```

Next shift report re-runs the above; any depended-on entry that
appears under PORT dispatches a port task per surface.
