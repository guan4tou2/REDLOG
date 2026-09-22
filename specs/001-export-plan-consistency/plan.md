# Implementation Plan: Trustworthy Export Preview and Execution

**Branch**: `001-export-plan-consistency` | **Date**: 2026-09-19 | **Spec**: [spec.md](./spec.md)

## Summary

Replace the generic preview plus format-specific execution callbacks with one canonical `ExportPlan`. The main process resolves format, bounded subset, snapshot, scope and sharing policies once; the renderer previews that immutable plan; execution accepts its identifier and refuses stale or altered input. Existing `ExportSnapshot` row bounds remain the dataset boundary.

## Technical Context

**Language/Version**: TypeScript 5.9, React 19, Node.js/Electron 44
**Primary Dependencies**: Electron IPC, React, better-sqlite3
**Storage**: Existing local SQLite project database and filesystem exports; no migration
**Testing**: Vitest 5, Testing Library, Playwright Electron E2E
**Target Platform**: macOS, Windows and Linux desktop
**Project Type**: Local-first Electron desktop application
**Performance Goals**: Resolve and render a 100,000-event preview without retaining full event payloads in renderer memory
**Constraints**: Preserve source evidence; offline operation; two event tiers; no new framework; no silent fallback from plan failure
**Scale/Scope**: JSON, NDJSON, Evidence Bundle, HAR and Timeline slice exports across renderer, preload, IPC, core and SQLite query layers

## Constitution Check

### Before design

- **I Evidence Integrity — PASS**: plans reference source rows and export copies only.
- **II Surface Truthfulness — PASS**: format, subset, counts, capability gaps and failures are explicit.
- **III Canonical Domain Semantics — PASS**: selection and policy resolution move into `src/core/export-plan.ts`.
- **IV Query Completeness — PASS**: plans use unbounded queries within explicit snapshot/subset bounds.
- **V Preview / Execute Consistency — PASS**: preview and execution share one immutable plan identifier and fingerprint.
- **VI Explicit Failure — PASS**: resolution, expiry and execution errors are typed outcomes.
- **VII Evidence Provenance — PASS**: event IDs, tier bounds and attachment references remain traceable.
- **VIII Risk-Based Test-First Verification — PASS**: contract and integration tests precede implementation.
- **IX Architectural Restraint — PASS**: extends current modules without new dependencies.

### After design

All gates remain satisfied. The bounded in-memory plan registry fits the immediate desktop confirmation workflow; a restart invalidates a plan visibly instead of persisting ambiguous approval state.

## Project Structure

### Documentation (this feature)

```text
specs/001-export-plan-consistency/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/export-plan.md
├── checklists/{requirements,delivery}.md
└── tasks.md
```

### Source Code (repository root)

```text
src/core/{export-plan,bundle-export,har-export}.ts
src/core/db/event-queries.ts
src/main/ipc/data-export.ts
src/preload/index.ts
src/renderer/src/components/ExportMenu.tsx
src/renderer/src/lib/exportScope.ts
src/renderer/src/env.d.ts
src/renderer/src/i18n/{en,zh-TW}.json
test/{export-plan,export-plan-ipc,export-menu,export-snapshot}.test.*
e2e/export-preview.spec.ts
```

**Structure Decision**: Keep the existing layered desktop structure. Core owns selection semantics, IPC owns orchestration and file dialogs, preload exposes typed commands, and the renderer only presents plan data.

## Complexity Tracking

No constitution violations require exceptions.
