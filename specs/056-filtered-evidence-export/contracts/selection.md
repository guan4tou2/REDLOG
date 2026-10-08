# IPC and delivery contract

resolveExportPlan accepts a declarative ExportRequest; rejects unknown subset kinds, malformed filters/query/time/HTTP predicates and unsupported policy. Returns either explicit error or frozen preview, including zero matches. executeExportPlan accepts only planId and checks source/policy/attachments.

queryHttpFlowPage accepts HTTP filters in addition to EventFilter; both screen and export use it. Filtering precedes page limits. Snapshot is injected by export; selected pair members must remain below the snapshot even when outside selected request-start time.

UI offers whole project and current selection independently. Selection summaries include query, time, target, type, scope, personal, tier and HTTP predicates. Sorting/highlighting/collapse never silently change membership. Preview states projection limits; zero is visible and confirmation disabled. All strings English/Traditional Chinese.

Verifier projection success explicitly means delivered files and eligible original rows verified, not source chain completeness or transformed source bytes verified. Unknown modes, missing/modified listed files, duplicate IDs, count mismatch and incorrect original row hashes fail.
