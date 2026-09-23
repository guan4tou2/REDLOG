# Research: One Retention Model

- **Decision**: one section, two knob names, no migration.
- **Why not migrate old keys**: Spec 006 — pre-release, no compatibility
  shims. The direction of the failure matters more than the absence of a
  migration: an unread old key leaves the store at its keep-forever default, so
  the worst case is disk growth, never deleted evidence. An interpreted key
  that was misread would fail the other way.
- **Why `terminal.maxCastBytes` stays**: it truncates a single recording while
  it is being written. Nothing is deleted by it; it bounds capture, not
  storage, and moving it into `retention` would put a capture limit next to
  deletion policy.
- **`agentTranscripts.keepDays`**: the sweep read it, but no config type
  declared it and no document listed it. It is real behaviour (the sidecar
  sweep and its `agent_transcript_pruned` audit), so it is declared rather than
  removed, with the v0.7.4 F2 reason its default must stay `0`.
- **`io.keepDays`, `io.warmDays`, `io.maxBytes`** in `docs/TESTING.md` do not
  exist in the source. They are removed from the reference.
