# Feature Specification: Report Mode

**Feature Branch**: `feat/managed-http-capture`
**Created**: 2026-09-22
**Status**: Verified

An operator writing a report needs live producers paused while search, replay,
filters and export remain usable. The gap must say why it exists.

## Requirements

- **FR-001**: Recording mode MUST be `recording`, `paused`, or `reporting`.
- **FR-002**: Reporting MUST use the existing write gate; reads and exports
  MUST remain available.
- **FR-003**: Entering and leaving reporting MUST append distinct chained audit
  events with source attribution.
- **FR-004**: Status Bar and the main action area MUST label reporting
  distinctly from an unexplained pause.
- **FR-005**: Existing pause/resume callers and shortcuts MUST retain their
  current behavior.

## Success Criteria

- A report-mode interval is distinguishable from a manual pause in both live UI
  and historical events.
- Search and export IPC remain callable while reporting.
