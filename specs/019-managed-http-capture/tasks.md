# Tasks: Managed HTTP Capture

## Phase 1 — Contract and tests

- [x] T001 [US1] Add failing lifecycle and readiness tests in test/managed-http-proxy.test.ts
- [x] T002 [US2] Add failing browser gating contract tests in test/managed-http-proxy.test.ts
- [x] T003 [US3] Add failing proxy environment tests in test/terminal-proxy-env.test.ts

## Phase 2 — Core implementation

- [x] T004 [US1] Implement owned mitmdump lifecycle in src/main/services/managed-http-proxy.ts
- [x] T005 [US1] Wire project lifecycle and proxy IPC in src/main/index.ts
- [x] T006 [US2] Gate browser launch on proxy readiness in src/main/index.ts
- [x] T007 [US3] Inject live proxy environment in src/main/terminal-manager.ts

## Phase 3 — Operator surface

- [x] T008 [US1] Expose proxy IPC types in src/preload/index.ts and src/renderer/src/env.d.ts
- [x] T009 [US1] Add compact status and controls in src/renderer/src/components/DashboardView.tsx and settings/BrowserPanel.tsx
- [x] T010 [US1] Add truthful bilingual copy in src/renderer/src/i18n/en.json and zh-TW.json

## Phase 4 — Verification

- [x] T011 Verify focused tests, typecheck, full suite, build and Spec Kit gate
- [x] T012 Run the managed HTTP desktop journey and record verification in specs/019-managed-http-capture/verification.md
- [x] T013 Analyze/converge artifacts and mark Spec 019 Verified


- [x] T014 Explicit start and opt-in terminal routing; verify stopped port edits
