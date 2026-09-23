# Mirror-hybrid pilot (task-loxs5)

Experimental vendor-branch structure: pristine upstream + overlay compose.

- `compose-overlay.sh` — deterministic compose (verified byte-identical across runs).
- `overlay/bin/` — the 9 beads-cluster files, verbatim from the fork line. The directory IS the file list.
- Proven: overlay wins, pristine kept, fork-only additions present.

Still to build (per bead): flagged-overlap enforcement, provenance recording,
overlay blame helper, trial merge.
