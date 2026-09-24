# Verification: First-Engagement Onboarding

## RED

- W3 `test/scope-input.test.ts` (6): `Cannot find module …/lib/scopeInput`.
- W3 `test/project-picker-scope.test.tsx` (6): 5 failed — no Scope field on
  the create card, no local-IP checkbox, no empty-scope note, Advanced still
  held scope/exclude fields.
- W6 `test/capture-readiness.test.ts` (4): `agent-tailer` chosen as nextStep
  (expected `shell-hook`); `onboardingComplete` undefined.
- W6 `test/first-run-record-terminal.test.tsx` (11): record-terminal UI and
  success copy absent; the view still offered "打開時間軸".
- Coordinator `test/create-config-merge.test.ts` (3): `mergeInitialConfig is
  not a function`; `project-picker-scope` updated to expect `personalDomains`
  in the create call and no `config.save`.

## GREEN

- Integrated branch, outside the sandbox: 222 files, 2333 tests pass
  (2 skipped); `e2e/first-run.spec.ts` 6/6 pass.
- `npm run typecheck`, production build, `verify:architecture` (7
  allowlisted) and `verify:specs` pass.
- Not verified: a real Windows host (PowerShell/WSL verification), a manual
  run through the packaged app.

## Gates

| Gate | Result | Date |
|------|--------|------|
| Clarify | 4 answered (empty scope, nonce proof, HTTP optional, merge on create) — in spec.md | 2026-09-24 |
| Checklist | `checklists/requirements.md`: 5 items, all pass | 2026-09-24 |
| Analyze | 1 finding fixed: shallow `scope` merge on create would drop loopback defaults — `mergeInitialConfig` appends | 2026-09-24 |
| Converge | 1 finding fixed: README and user guide still said scope is added one entry at a time under Advanced | 2026-09-24 |
