# Export dialog contract

Open → snapshot current view contribution → resolve. No intermediate format menu or second confirmation screen.

Change format → same subset; change range → same format. Current selection preserves typed query, HTTP predicates, date bounds and housekeeping policy. All is explicitly {kind: all}. Optional attachments are excluded by id and re-resolved.

Confirm is unavailable while resolving, on preview error, for an empty selection, or after a failed execution until a new plan resolves. Controls are locked during execution. Escape/cancel closes the dialog when not running, invalidates pending previews and restores focus. Preview failure allows retry and closing. No source evidence is changed.

Unsupported policies are explained, not advertised as applied. HAR preview describes exchanges using the canonical counts. Empty web scope warns but permits export. Success offers reveal; only successful execution closes the dialog.
