# Implementation Plan: Transcript Step Picks

## Canonical module interfaces

- `src/renderer/src/lib/transcriptSnippet.ts`: step to Markdown with provenance.
- `src/renderer/src/lib/transcriptPicks.ts`: which steps are picked, from markers.
- `marker:create` IPC: `causes`, `targetId`.
- `TranscriptView.tsx`: pick, "Picked only", per-step copy.

## Constitution Check

- **I. Evidence Integrity**: a pick is an append-only marker; no event changes.
- **VII. Evidence Provenance**: each copy names its events, times and completeness.
- **Product Boundary**: no report generation or scoring (FR-004).
