# Transcript route consolidation — 2026-11-09

## Implemented

- App renders TranscriptView only through RecordingWorkspace. The legacy
  `transcript` navigation target opens Activity → Input / output instead of
  mounting a separate workspace.
- AI conversations use the Activity AI reading tab. Both readers share the
  workspace query and source/Session filters; previously visited readers stay
  mounted so their reading position is retained.
- Existing command-palette navigation remains a compatibility alias. Timeline
  return restores the same Activity workspace rather than a separate route.
- No event schema, source authorization, masking or export policy is changed.

## Verification

- Electron: evidence-views, external-session and official-agent-capture:
  **27 passed**. Includes Claude/Codex capture, Session selection, query,
  Timeline/back, HTTP request/response, live arrival preservation, external PTY
  output search and export, and capture removal with saved history readable.
- Existing focused workspace/navigation unit tests: **31 passed**; the workspace
  suite with the additional requested-reading regression case: **4 passed**.
- App-shell Electron cases: **27 distinct cases passed**. One create-project
  case received an external input-method keystroke during the first run; that
  serial group (3 cases) was rerun successfully. No automatic retry was used.
- Typecheck, spec, architecture and i18n gates passed.
- Full local unit suite after test isolation: **5913 passed, 41 skipped**.

Native Windows/WSL interaction is not established by this macOS Electron run.
The initial full local unit run exposed three test-isolation failures in
relay-contract and shell-token-not-in-argv. The tests now use an isolated relay
home and wait for background sending to start before declaring completion;
their original assertions are unchanged and all 12 relevant cases passed.
