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
| spawn_crew | bin/fm-spawn.sh | evolving | task, project, mode, yolo | dispatch writes |
| scaffold_brief | bin/fm-brief.sh | evolving | task, repo, mode/scout | dispatch writes |

## How to use this view

Filter schema/contracts.yaml by stability to answer what breaks when a script header changes.
A stable row pins an exact output schema id and fails validation when the pin goes stale.
An evolving row pins a safe flag subset and fails when flags outside the subset appear.
Nothing in this map is observed-only yet; when an observed surface arrives, it enters with tier experimental and no pin.
