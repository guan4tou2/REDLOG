# Verification — US6

1. Run the export UI regression files (including unified dialog behavior), typecheck and repository i18n/architecture/spec gates.
2. Build, then run affected Electron export-preview and filtered-export journeys. Check exported contents against the approved selection including an event added after preview.
3. In the isolated Mac app, open from a filtered view: switch JSON → NDJSON → bundle without losing conditions; explicitly select all; exclude an attachment; change/cancel destination; cancel with Escape and reopen. Verify one confirmation and artifact contents.
4. Resize the desktop window: labels wrap, controls remain reachable, dialog scrolls, keyboard focus stays inside. Windows native installation remains NOT RUN on this Mac.
