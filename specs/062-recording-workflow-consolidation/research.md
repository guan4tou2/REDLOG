# Research — US6 export dialog

Local sources inspected: ExportMenu.tsx, exportScope.ts, FilterContext.tsx, export-plan.ts, export-capabilities.ts, data-export.ts and existing export tests.

- Existing ExportPlan already owns scope, all-page selection, attachment exclusions and execution snapshots. Reuse it; do not add a second exporter.
- The menu currently binds NDJSON/bundle to all-project requests. Separating range from format fixes this visible ambiguity.
- Freeze the current contribution on opening rather than watching a live view while reviewing a snapshot.
- Existing sequence protection is sufficient for overlapping previews; preserve and test it for all edits and close.
- HAR cannot scrub PII or mask scope; show format capability truthfully. JSON has no bundled attachments; keep the existing explanation.
- No external dependency or unanswered technical research question; no parallel research needed.
