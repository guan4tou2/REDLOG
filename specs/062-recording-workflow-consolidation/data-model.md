# Data model — US6

No evidence/schema changes. Existing ExportRequest and ResolvedExportPlan remain canonical. The bounded 2026-10-24 increment adds machine-local delivery metadata, described below.

Dialog draft: frozen current subset and optional view disabledReason; selected range current/all; selected supported format; mask and PII choices; excluded attachment ids; selected destination. Range and format are independent. Default range is current. No loaded row ids are used to reconstruct selection.

Preview state: resolving / resolved / failed. A request edit or close invalidates the prior generation synchronously. Only the latest successful generation supplies an executable plan. Running locks draft controls; execution failure retains draft and requires a fresh plan.

## Last successful delivery (2026-10-24)

`ExportDelivery` contains the actual artifact path, supported format, completion timestamp and derived file availability. Main stores one successful receipt per `(project id, resolved project root)` in Electron userData/recent-exports. It writes an owner-only temporary file and atomically renames it after all export/manifest writes succeed. Cancel/failure never replaces the receipt. Missing receipt is distinct from unreadable/invalid metadata; missing/inaccessible artifacts retain their identity. Metadata-write failure preserves the artifact and reports a warning.

The receipt is UI state, not evidence, an export plan, a saved query, a backup or a portable project artifact. It is not included in bundles. Reopening/copying a project on another machine does not import path authorization. The renderer cannot write arbitrary receipts. Reveal may use existing approved locations or the exact successful artifact for the current project. Selection, scope, attachments and fingerprint still come solely from ExportPlan.
