# Implementation Plan: Local Evidence Files

## Canonical module interfaces

- `src/core/artifacts.ts`: `addArtifact`, `artifactRelatedCommands`; outcome
  types `ArtifactAddOutcome` / `ArtifactAddResponse`.
- `src/main/ipc/artifacts.ts`: picker (`artifacts:add`) and drop
  (`artifacts:addDropped`) with the main-process confirmation dialog.
- `src/core/export-attachments.ts`: `storedArtifactOf`; the `artifact` kind.
- Renderer: palette entry, title-bar FilePlus button, App drop zone, batched
  toasts.

## Constitution Check

- **VII. Evidence Provenance**: hash of the copy, original path and mtime;
  cwd-and-time overlap is a candidate, never `_causes`.
- **VI. Explicit Failure**: every outcome is reported per file.
- **Product Boundary**: nothing scans a folder or fetches from a target.
