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
| spawn_crew | bin/fm-spawn.sh | evolving | task, project, mode, yolo | dispatch writes |
| scaffold_brief | bin/fm-brief.sh | evolving | task, repo, mode/scout | dispatch writes |
| receipt_submit | native: receipt store (state/mcp-receipts/) | experimental | <tool> <arguments> | detach long calls past the 30s budget |
| receipt_status | native: receipt store (state/mcp-receipts/) | experimental | <receipt_id> | running/done/failed checks with result on completion |

## How to use this view

Filter schema/contracts.yaml by stability to answer what breaks when a script header changes.
A stable row pins an exact output schema id and fails validation when the pin goes stale.
An evolving row pins a safe flag subset and fails when flags outside the subset appear.
Nothing in this map is observed-only yet; when an observed surface arrives, it enters with tier experimental and no pin.
