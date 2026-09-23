# Feature Specification: Report Mode (withdrawn)

**Status**: Withdrawn

The operator rejected a separate reporting state on 2026-09-22. Writing a
report does not imply capture should stop. Keep the existing recording/pause
control, pause/resume audit events, and access to search, replay and export.
Remove reporting IPC, UI, translations and tests; no compatibility shim.
Historical commits preserve the abandoned implementation.
