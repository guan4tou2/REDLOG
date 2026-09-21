# Tasks

- [x] T001 Add a guard test forbidding direct `insertEvent` and manual publish in bounded capture producers. RED: 7 of 8 source cases failed before migration.
- [x] T002 Migrate terminal and transcript capture through canonical ingest without changing payload schemas.
- [x] T003 Migrate CDP and screenshot capture while preserving explicit target and manual screenshot pause bypass.
- [x] T004 Migrate connection, process and file-watcher capture while preserving capture-health failures.
- [x] T005 Migrate agent tailer primary capture events while retaining its dedicated agent-tool scope dispatch.
- [x] T006 Verify the source guard (8 cases), targeted producer/ingest tests (84 cases), typecheck, production build and Electron command-I/O plus connection-capture journeys (8 cases).
