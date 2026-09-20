# Conformance fixtures

Prove the TypeScript MCP server behaves like firstmate: the same read inputs through the
server and through firstmate's real `bin/fm-*.sh` scripts agree.

## Run

```sh
bash tests/conformance/conformance.sh
```

Point at a firstmate checkout (defaults to the well-known local checkout):

```sh
FIRSTMATE_HOME=/path/to/firstmate bash tests/conformance/conformance.sh
```

Or run the suite directly:

```sh
(cd ts && bun run conformance:bun)
```

## TypeScript server multi-runtime proof

The TS implementation in `ts/` is proved across both Bun (primary) and Node (fallback compat):

```sh
bash tests/conformance/ts-parity.sh
```

`ts/tests/conformance-*.test.ts` runs the TS read-tool equivalence fixtures hermetically with no live checkout across three parallelizable shards (`conformance-read`, `conformance-remote`, `conformance-system`) with per-runtime input hashing. All tests are side-effect-free by construction (stub homes only, read boundary plus validation refusals).

## What equivalence means here

Same read input, same observable read result. The adapter's typed
projection (`fleet_snapshot`, `backlog`, `crew_state`, `status_tail`,
`fleet_poll`) equals the owning script's output, modulo the result envelope
wrap and the `generated` timestamp, which moves every run.

One deliberate asymmetry: the adapter may be **stricter** than the script.
Traversal ids (`../escape`) are refused with `invalid-id` before any process
starts, while the raw `fm-crew-state.sh` answers a lax `unknown` line.
Stricter-is-conformant and the suite pins that direction. The reverse — the
adapter accepting what the script refuses — fails.

`status_tail` has no owning script (it is a bounded, confined file read
native to the adapter), so its equivalence is against the file tail itself,
plus confinement both sides agree on.

## Side-effect-free enforcement

Conformance never mutates fleet state; the suite asserts it:

1. Only read tools dispatch. The suite wraps `Adapter.dispatch` to raise on
   any non-read tool, so no steer, lifecycle, spawn, brief, decision, or
   relay call can fire.
2. Scratch scope. Every subprocess runs with `FM_HOME`/`FM_STATE_OVERRIDE`
   pinned to a temp dir, and the suite asserts the snapshot's own
   `fm_home`/`roots.state` resolve inside that scratch dir — never the live
   checkout.
3. Read-only process boundary. The guarded runner refuses any script outside
   the read-script set (`READ_SCRIPTS` in the suite: snapshot, crew-state,
   peek, fleet-view, review-diff, bearings-snapshot, wake-drain, guard,
   remote-doctor, remote-file, remote-delta, harness, project-mode, lock,
   lease, bearings-board, inbox, contributions, mail, voice-records, lint,
   tool-update-check, vendor-auth-probe, startup-memory-budget, pr-state,
   x-poll).
4. Per-process proof. Every spawned process is captured carrying
   `FM_HOME=<scratch>`, never the live checkout. (A live `state/` dir
   fingerprint would flake: the fleet is busy and other agents append
   status concurrently, so env capture on each invocation is the
   deterministic proof.)
