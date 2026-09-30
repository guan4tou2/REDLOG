# Implementation Plan: UI/UX Audit Remediation

## Canonical module interfaces

- Batch 1 (#234): `EventMarker` save handling; `useAppCounts` `scopeUnknown`
  and `retry`; TargetView and ScreenshotsView error states; `CopyButton`;
  `capToasts`; `test/i18n-terminology.test.ts`.
- Batch 2 (#235): `screenshot-agent` `holdFrame`, `setWindowHider`, cursor
  display; global `QUICK_SHOT_ACCELERATOR`; `Modal.tsx`, `IconButton.tsx`;
  export preview as a dialog; `openInTimeline` / `goBack` return bar.
- Batch 3 (#236): derived theme shades in `styles/index.css`;
  `TimelineEventLog`, `TimelineEventInspector`; `test/design-palette.test.ts`,
  `test/button-names.test.ts`.

## Constitution Check

- **II. Surface Truthfulness** and **VI. Explicit Failure**: FR-001, FR-002.
- **VII. Evidence Provenance**: a held frame records when it was taken.
- **IX. Architectural Restraint**: the extracted Timeline parts take props
  only, the `MarkerDetail` pattern; no new state layer.
