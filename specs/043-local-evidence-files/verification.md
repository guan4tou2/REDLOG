# Verification: Local Evidence Files

## RED

Re-run on 2026-09-30 with each PR's tests against the commit before it:

- `b325069^1`: `test/artifacts.test.ts`: `Cannot find module '../src/core/artifacts'`;
  `test/export-plan-ipc.test.ts`: "carries an operator-added artifact with its
  event, and leaves it out when the operator does (#221)" failed.
- `086979e^1`: `test/artifacts-dropped.test.ts`: 3 failed
  (`handlers.get(...) is not a function`: no `artifacts:addDropped`).

## GREEN

- On main `2f995b4`: `artifacts` 9, `artifacts-dropped` 3 and
  `export-plan-ipc` pass.
- Full vitest 2862 pass; the 5 failing files are the environment-only ones.
- Typecheck, `verify:architecture`, `verify:specs` pass; CI on PRs #232 and
  #235 green.

## Operational Verification

Risk surface: none

Not required: the tests copy and hash real files in a temporary project; no
capture source or packaging is involved.

## Release Impact

| | |
|---|---|
| User-visible | yes |
| Breaking | no |
| Packaging affected | no |
| CHANGELOG updated | yes |
| Upgrade note required | no |
| Packaged smoke required | no |

## Gates

| Gate | Result | Date |
|------|--------|------|
| Clarify | no open questions; the decisions (operator-chosen files only; overlap is a candidate) are FR-001 and glossary rule 6 | 2026-09-30 |
| Checklist | `checklists/requirements.md`: 5 items, all pass | 2026-09-30 |
| Analyze | no findings | 2026-09-30 |
| Converge | 0 findings | 2026-09-30 |
