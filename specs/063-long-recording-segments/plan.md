# Implementation Plan: Long recording preservation

**Date**: 2026-10-26 | **Spec**: [spec.md](spec.md)
**Working branch**: codex/first-use-recording-guidance (existing isolated checkout)

## Technical context

Electron/React/TypeScript, Node filesystem/SQLite, standard Python shell helpers; existing lockfile and runtimes, no new dependency. Preserve recording hot-path incremental hashing and bounded memory. 50 MiB becomes a cast-part budget. Existing relay/session memory queues remain bounded; their source-loss counters must remain explicit. Target macOS/Linux/Windows, with actual acceptance labeled per OS.

## Design and source boundaries

TerminalRecording owns part rotation, per-part and aggregate hashes. Logical byte offsets count part headers too. cast-slice owns ordered discovery and bounded preview across parts; export-attachments applies recording attribution to each part, while ExportPlan freezes actual prefixes. terminal-manager records closed part metadata and indexes each part. Export-selection requests all command companions rather than the preview limit. Existing shell producers retain their job-control and consent gates; extend continuous output only with behavior/fault-injection evidence.

## Constitution check — before and after design

Integrity/provenance: append-only parts, explicit closed hashes, no inferred interactive commands. Truthfulness/completeness: preview subset explicit; export has no 2,000-row companion cap. Preview/execute: existing ExportPlan owns snapshot/digest. Failure: disk failure nullifies aggregate success, interrupted sessions stay interrupted. Privacy: source/target/paused gates unchanged. Restraint: existing modules and formats, no new framework, setting or mode. Risk-based verification starts with failing observable tests. No exception identified.

## Work sequence

Failing capacity/attribution/export tests → writer/reader/manager/export wiring → shell and transport limits → focused regression/typecheck/build → affected desktop/package checks → actual OS matrix. Full issue status remains Draft until HTTP and cross-platform fault checks are complete.
