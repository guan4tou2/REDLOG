# Tasks: One Scope Classifier

## Phase 1 — Contracts

- [x] T001 Add failing tests that one adjacent host in bare, uppercase,
      trailing-dot, host:port and URL form yields one distance.
- [x] T002 Add a failing test for the exclude-only project in both views.
- [x] T003 Add a failing property test that the filter status and the
      distance agree over a corpus of subjects and scopes.
- [x] T004 Add a failing guard test: no scope classifier exported outside
      `scope-evaluator.ts`, and export masking imports nothing from
      `core/alert`.

## Phase 2 — Implementation

- [x] T005 Move the adjacency helpers, `ScopeIndexes`, `buildScopeIndexes`
      and `ScopeDistance` into `scope-evaluator.ts`.
- [x] T006 Implement `classifyScope` with one normalisation before every rung.
- [x] T007 Re-implement `evaluateScope` as the status view.
- [x] T008 Reduce `classifyScopeTarget` to the authority/severity mapping.
- [x] T009 Point `scope-sanitize.ts` at `scope-evaluator.ts`.
- [x] T010 Remove the duplicate `ScopeSnapshot`.

## Phase 3 — Verification

- [x] T011 Run the scope, alert and recompute suites, typecheck, the full
      suite and build.
- [x] T012 Update `docs/domain/SPEC-scope-evaluation.md`.
- [x] T013 Record verification and mark Verified.
