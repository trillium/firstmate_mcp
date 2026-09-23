# Mirror-hybrid pilot (task-loxs5)

Experimental vendor-branch structure: pristine upstream + overlay compose.

- `compose-overlay.sh` — deterministic compose (verified byte-identical across runs).
- `overlay/bin/` — ONLY services we modified (class D). Currently one file:
  `fm-tasks-axi-lib.sh`. Pure additions (class A) never conflict with anything
  upstream, so they don't get overlay treatment — they go the mirror route
  (doorway wrappers per decision-fnn) or ship as plain files.
- Sourced libs (`*-lib.sh`) stay unwrapped by construction; their reads are
  served through owning state files, never reimplemented.

Rule (owner 2026-09-23): migrate-only-for-modified; every other fork surface
is targeted as a mirror.

Still to build (per bead): flagged-overlap enforcement, provenance recording,
overlay blame helper, trial merge.
