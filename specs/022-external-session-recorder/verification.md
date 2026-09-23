# Verification: Explicit External Session Recording

Date: 2026-09-23. Platform: macOS arm64. Branch: feat/managed-http-capture.

## Requirements and evidence

- Real PTY tests verify merged output, TTY descriptors, initial geometry,
  Ctrl+C, exit status, failed executable boundaries and a stable session ID.
- Output cap leaves terminal output live and records truncation/omitted bytes.
- Paused and failed deliveries are not replayed; final accepted/omitted/paused
  counters explain capture loss. Unavailable final delivery warns locally.
- API tests reject mismatched engagement headers. A streaming-request test
  reproduced a 201 write after project switching, then passed with 409 after
  adding a second identity check after the awaited body read.
- Child shells suppress ordinary metadata hooks so those hooks cannot read
  newly active credentials and bypass the recorder's pinned identity.
- Search shows a PTY output preview; Transcript exposes expandable output.
  Electron journey records output, pauses, expands it, searches and exports.
- Installer plans and starter-pack copy the helper beside both adapters.
  Resource verification checks the helper in the actual macOS App.
- A fresh packaged App opens a project, installs its bundled Zsh hook into an
  isolated HOME, invokes redlog-session through that hook, and finds the output
  through the real Search UI.

## Automated checks

- Full Vitest: 197 files passed, 2,243 tests passed, 2 platform-specific skipped.
- TypeScript typecheck and production build passed.
- Source desktop journeys: managed HTTP, personal visibility/Loot, ordinary
  pause/resume, pause semantics, and external-session search/export passed.
- macOS unsigned directory package, resource check and packaged-session smoke
  passed. This is a local App smoke, not a notarized installer certification.
- Spec gate and whitespace checks passed at final closeout.
- Final idempotent pause/resume check: 7 event-bus tests passed. Final rebuilt
  package plus pause/resume desktop closeout: all 12 checks passed.

## Observed test limitations

The first full run missed a native file-watcher notification. That test passed
in isolation, and the subsequent full run passed. No product change was made to
hide the failure or increase its timeout. Desktop fixture corrections initialized
the fresh Zsh profile, used the installed hook path, opened hidden views via
normal shortcuts/palette, and expanded Transcript's collapsed output.

## Scope and convergence

No additional record store, compatibility shim, automatic external interception,
reporting mode, generic plugin framework, or target workspace was introduced.
Pause is evaluated when the server receives a chunk, as for existing API
producers; a bounded queue is not a timestamp-exact privacy boundary. There is
no offline output recovery. Output events are not asciicast replay. Input echoed
by the child appears in output. Redaction remains the existing ingest policy.

Native Linux, Windows/PowerShell and WSL have not been run on real machines in
this change. The new launcher is POSIX-only; cross-host WSL transport is not
implemented. Windows retains its existing transcript integration. Missing Python
or an unavailable/paused server refuses a new session before launching a child.
