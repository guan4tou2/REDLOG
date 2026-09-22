# Tasks: Pre-release Contract Reset

## Phase 1 — Inventory and guardrails

- [x] T001 Inventory executable compatibility aliases, shims and migrations across `src/`, `hooks/`, `cli/`, `plugins/` and tests.
- [x] T002 Define the removal boundary and resilience exclusions in `specs/006-pre-release-contract-reset/spec.md` and `research.md`.

## Phase 2 — Current external contracts

- [x] T003 [US1] Add failing tests that reject quickmark/findings aliases and require current bookmark contracts in `test/api-server.test.ts`, `e2e/cli-smoke.spec.ts` and `test/plugins.test.ts`.
- [x] T004 [US1] Remove HTTP, CLI and plugin aliases in `src/core/api-server.ts`, `cli/redlog-cli.js`, `src/core/plugins/host.ts` and `src/core/plugins/types.ts`.
- [x] T005 [US1] Migrate renderer event consumers to batch delivery and remove per-event IPC in `src/renderer/src/`, `src/preload/index.ts` and `src/main/index.ts`.
- [x] T006 [US1] Remove legacy export IPC and route all exports through ExportPlan in `src/main/ipc/data-export.ts`, preload types and renderer callers.

## Phase 3 — Current domain and persisted shapes

- [x] T007 [US2] Migrate target and scope callers to canonical interfaces and remove wrappers in `src/core/target-extractor.ts` and `src/core/db/event-aggregates.ts`.
- [x] T008 [US2] Remove old table/config/local-storage migrations in `src/core/db/index.ts`, configuration loaders and renderer state components.
- [x] T009 [US2] Remove legacy event output, tier, hash and signature shapes in core verification and renderer details.
- [x] T010 [US2] Remove historical hook/spool runtime paths while retaining current offline recovery.

## Phase 4 — Production surface and specifications

- [x] T011 [US3] Move transcript test helpers out of production exports and update tests.
- [x] T012 [US3] Remove compatibility re-exports and deprecated no-op integrations; update current documentation.
- [x] T013 [US3] Correct `005-shell-adapter-boundaries` tasks, checklist and verification to the final adapter-only behavior.

## Phase 5 — Verification

- [x] T014 Run targeted tests for each removed contract and record RED/GREEN evidence in `verification.md`.
- [x] T015 Run full tests, typecheck, build and affected Electron journeys; classify unrelated failures in `verification.md`.
- [x] T016 Run Spec Kit Analyze and Converge, close remaining gaps and mark this feature Verified.
