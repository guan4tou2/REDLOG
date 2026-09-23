# Feature Specification: One Retention Model

**Feature Branch**: `refactor/one-retention-model`
**Created**: 2026-09-23
**Status**: Verified
**Input**: Put every store's retention settings in one section, spelled the same way, so an operator can see and set how long each kind of evidence is kept without learning five naming schemes.

RedLog keeps six stores that can be cleaned up: terminal recordings,
screenshots, HTTP bodies, agent transcript sidecars, logged-tier rows and
bookmarks. Two ideas govern them — delete by age, evict under size pressure —
but they were spelled five ways across four config sections:

| Store | Age | Size |
|---|---|---|
| casts | `terminal.castKeepDays` | `terminal.castStoreMaxBytes` |
| screenshots | `screenshots.keepDays` | `screenshots.maxBytes` |
| HTTP bodies | `httpBodies.keepDays` | `httpBodies.maxBytes` |
| agent transcripts | `agentTranscripts.keepDays` (read by the sweep, declared nowhere) | — |
| logged tier | `retention.loggedTier.keepDays` | — |
| bookmarks | `retention.bookmarks.keepDays` | — |

`screenshots` (retention) also sat next to `screenshot` (capture cadence and
quality), one letter apart.

## User Scenarios & Testing

### User Story 1 - One place for retention (Priority: P1)

As an operator, I need every store's retention in one section with the same
two knob names, so I can read a project's config and know what will be kept.

**Independent Test**: The default config declares `retention.casts`,
`retention.screenshots`, `retention.httpBodies`, `retention.agentTranscripts`,
`retention.loggedTier` and `retention.bookmarks`, and no retention knob exists
outside that section.

### User Story 2 - Behaviour is unchanged (Priority: P1)

As an operator, I need the sweeps to do exactly what they did: keep forever by
default, prune by age with an audit row per file, evict coldest-first with
in-scope files pinned.

**Independent Test**: The existing retention, artifact-eviction and
body-eviction suites pass with only their config literals changed.

### Edge Cases

- A config written before this change, using the old spellings, prunes and
  evicts nothing — the keep-forever default — rather than being interpreted.
- `terminal.maxCastBytes` truncates one runaway recording. It is a capture
  limit, not retention, and stays under `terminal`.

## Requirements

- **FR-001**: Every store's retention MUST be declared under
  `retention.<store>`, using `keepDays` for age and `maxBytes` for size.
- **FR-002**: Every retention knob MUST default to `0`, meaning keep forever or
  unbounded.
- **FR-003**: The sweeps MUST read only the new spellings; no source file may
  read the old ones.
- **FR-004**: Sweep and eviction behaviour MUST be unchanged.
- **FR-005**: The Settings page MUST edit the size budgets at their new paths.
- **FR-006**: The operator-facing option reference (`docs/TESTING.md` §2.6)
  MUST list the real keys, and MUST NOT list options that do not exist.

## Success Criteria

- **SC-001**: `grep` finds no old retention spelling in `src/`.
- **SC-002**: The retention, eviction and config suites pass.

## Assumptions

- Pre-release (Spec 006): old spellings are not migrated. The failure mode is
  that a budget or window set before the change stops applying and the store is
  kept — never that evidence is deleted.
