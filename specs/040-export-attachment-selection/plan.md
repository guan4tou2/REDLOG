# Implementation Plan: Export Attachment Selection

## Canonical module interfaces

- `src/core/export-attachments.ts`: `listExportAttachments()`, one row per
  file, and `isAttachmentId()`.
- `src/core/export-plan.ts`: `ExportRequest.excludeAttachments`, normalised
  (valid paths, sorted, unique); `countExportAttachments` honours it and
  reports `excludedByOperator`.
- `src/main/ipc/export-plan.ts`: resolve lists attachments; execute re-checks
  counts and passes the exclusions to `exportBundle`.
- `bundle-export`: skips excluded files; writes the manifest `attachments`
  section.
- `ExportMenu`: the per-file checkbox list.

## Constitution Check

- **V. Preview / Execute Consistency**: the exclusions are part of the request
  and the fingerprint; execute re-checks the counts.
- **II. Surface Truthfulness**: a cast is labelled by the targets it touched,
  never by the export's scope.
- **I. Evidence Integrity**: source files are never modified.
- **Domain**: `SPEC-export-event-selection.md` updated (T004).
