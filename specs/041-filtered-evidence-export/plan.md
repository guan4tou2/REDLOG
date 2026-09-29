# Plan: complete filtered evidence export

Branch: codex/evidence-workflow-completion · 2026-09-28 · [Spec](spec.md)

## Summary
Carry declarative investigation predicates through existing ExportPlan; resolve over SQLite before pagination, snapshot identities, execute frozen selection. HTTP pages and export call the same flow query. Bundles explicitly distinguish a complete source chain from a projection.

## Technical Context
TypeScript, React, Electron, better-sqlite3; existing Vitest/Playwright and Python verifier. No new dependencies, schema migration or capture engine. Desktop macOS/Windows/Linux. Complete selection may be large; SQL filters precede limits, use keyset pages for resolving ordinary event queries. Keep all source IDs and bytes unless an explicit existing privacy policy transforms delivery.

## Constitution Check
Evidence integrity: preserve source hashes, mark transformed projections. Surface truthfulness: exact event/exchange counts, no loaded-page inference. Canonical semantics: use event query and HTTP flow query. Query completeness: iterate hasMore under snapshot. Preview/execute: freeze IDs/policy/attachments. Explicit failure: reject invalid input/unsupported combinations. Architectural restraint: existing modules only. PASS before and after design; no exceptions.

## Project Structure
- src/core/export-plan.ts: validated selection contract
- src/core/db/event-queries.ts: snapshot-aware canonical event/HTTP query
- src/main/ipc/data-export.ts: selection resolution and approved execution
- src/core/bundle-export.ts, tools/redlog-verify.py: projection contract
- src/renderer/src/components/{ExportMenu,HttpHistoryPanel,Timeline,Search,TranscriptView}.tsx and lib/exportScope.ts: current-selection contribution
- test/: unit/integration regression; e2e/: real operator journeys

## Implementation sequence
US1 event selection → US2 HTTP flow selection → US3 projection verification → cross-layer/UI verification. Tests precede implementation. See tasks.md. Installer acceptance is recorded separately from feature correctness.
