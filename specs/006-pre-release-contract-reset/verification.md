# Verification: Pre-release Contract Reset

**Date**: 2026-09-22
**Result**: Verified

## RED evidence

- Historical HTTP, CLI and plugin aliases were accepted before the rejection
  assertions were added.
- Renderer consumers still depended on the single-event channel and three
  view-local export buttons still called removed preload methods.
- The database accepted multiple historical hash/event shapes and initialized
  fresh projects through migration branches.
- Old shell and Claude hook paths remained packaged or documented after their
  canonical replacements existed.
- The first full run exposed 13 failures: ten incomplete current-bridge mocks,
  two UI truthfulness/accessibility checks and one timing assertion tied to
  worker scheduling. Each was corrected against the current observable
  contract before the final run.

## Requirement coverage

| Requirement | Implementation evidence | Verification evidence |
|---|---|---|
| FR-001 | Removed quickmark/findings aliases, old hook files, per-event IPC and direct export IPC | Rejection tests, source inventory, CLI E2E |
| FR-002 | Current callers use batched events, ExportPlan, provenance target extraction and canonical scope matching | Typecheck, renderer and export suites |
| FR-003 | Fresh schema contains current fields; verifier accepts one canonical event/hash/signature shape | DB, chain, signing and bundled verifier suites |
| FR-004 | Project-scoped storage and required tier/output fields replace migration fallbacks | Renderer, persistence and event suites |
| FR-005 | Export UI resolves and executes one immutable ExportPlan; dead page-local buttons were removed | ExportPlan IPC, snapshot and single-control suites |
| FR-006 | Transcript and DB test helpers no longer expand production APIs | Typecheck and focused transcript suites |
| FR-007 | Offline spool, unavailable-key handling and runtime error states remain as operational resilience | Spool, signing, capture-health and pause suites |
| FR-008 | Spec, plan, tasks, checklist and this record describe the same completed scope | Analyze and Converge review below |

## Automated verification

- `npm run typecheck`: passed.
- `npx vitest run`: 169 files passed; 2031 tests passed; 2 explicitly skipped.
- Focused bundle, verifier, renderer and export run: 8 files and 65 tests passed.
- `npm run build`: passed. Vite reported existing chunk-placement warnings only.
- Electron journeys: 22 passed across first run, shell adapter installation,
  recording pause/resume, CLI bookmark/current commands, marker amendment,
  chain verification and evidence bundle export.
- Source inventory: no executable quickmark/findings aliases, single-event IPC,
  removed direct renderer export methods, or deleted shell/Claude hook paths
  remain in current source and operator documentation. Historical audit and
  changelog prose is retained as history.

## Analyze

- Every FR maps to at least one completed task and an observable verification.
- Spec, plan and tasks agree on the brownfield boundary: version-only
  translation is removed; operational failure handling remains.
- Constitution gates are satisfied: one event shape, one export path, explicit
  rejected aliases, current UI surfaces, and risk-based integration coverage.
- No unresolved clarification marker, unchecked task, or contradictory current
  interface was found.

## Converge

Final inventory found and closed three missed renderer export casts, stale
PostToolUse setup guidance, optional old-preload calls, and DB cache aliases.
No remaining implementation task is required for this feature.
