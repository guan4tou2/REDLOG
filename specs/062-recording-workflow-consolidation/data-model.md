# Data model — US6

No persisted entity changes. Existing ExportRequest and ResolvedExportPlan remain canonical.

Dialog draft: frozen current subset and optional view disabledReason; selected range current/all; selected supported format; mask and PII choices; excluded attachment ids; selected destination. Range and format are independent. Default range is current. No loaded row ids are used to reconstruct selection.

Preview state: resolving / resolved / failed. A request edit or close invalidates the prior generation synchronously. Only the latest successful generation supplies an executable plan. Running locks draft controls; execution failure retains draft and requires a fresh plan.
