# Tasks

- [x] T001 Add a POSIX integration test for live stdout, separated stderr, payload metadata and exit-code preservation. RED: the first marker arrived after command exit (1816 ms, required under 700 ms).
- [x] T002 Change POSIX `redlog-run` to stream output through per-stream FIFOs and tee while retaining capped structured capture.
- [x] T003 Expose metadata-only versus full-output capability in Capture Health with renderer tests and i18n.
- [x] T004 Update the external-shell operator documentation without claiming transparent capture.
- [x] T005 Run targeted tests (29), typecheck, build and the affected Electron first-run journey (5); record verification evidence.
