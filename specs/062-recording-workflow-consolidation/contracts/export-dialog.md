# Export dialog contract

Open → snapshot current view contribution → resolve. No intermediate format menu or second confirmation screen.

Change format → same subset; change range → same format. Current selection preserves typed query, HTTP predicates, date bounds and housekeeping policy. All is explicitly {kind: all}. Optional attachments are excluded by id and re-resolved.

Confirm is unavailable while resolving, on preview error, for an empty selection, or after a failed execution until a new plan resolves. Controls are locked during execution. Escape/cancel closes the dialog when not running, invalidates pending previews and restores focus. Preview failure allows retry and closing. No source evidence is changed.

Unsupported policies are explained, not advertised as applied. HAR preview describes exchanges using the canonical counts. Empty web scope warns but permits export. Success retains the completed artifact in the dialog until the operator closes it.


### Completed result and reopen (2026-10-24)

Success transitions to a completed-result view in the same dialog, rather than closing it. Close dismisses the view, not the artifact. Reopening can inspect the active project's last successful result on this machine; Export another starts a new frozen current selection. Failed/canceled attempts do not replace the last successful result. Missing artifact, unreadable metadata and failed reveal are explicit and do not claim a new completion. Machine metadata write failure warns while retaining the actual successfully created result. Result lookup grants no arbitrary path access.
