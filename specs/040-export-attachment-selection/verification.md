# Verification: Export Attachment Selection

## RED

Re-run on 2026-09-30 against `b325069^1` (main before PR #232), with the tests from
`b325069`:

- `test/export-attachments.test.ts`: `Cannot find module '../src/core/export-attachments'`.
- `test/export-attachment-list.test.tsx`: no `[data-testid="export-attachments"]`.
- `test/export-plan-ipc.test.ts`: 2 failed, "counts attachment files, missing
  refs and unattributed sidecars separately" and "lists a cross-target cast,
  and leaves it out of the bundle when the operator does".

## GREEN

- On main `2f995b4`: `export-attachments` 4, `export-attachment-list` 1,
  `export-plan-ipc` and `export-plan` pass.
- Full vitest 2862 pass. The 5 failing files are environment-only and fail on
  main alike: the three node-pty suites and the two Python cffi verifier tests.
- Typecheck, `verify:architecture` and `verify:specs` pass. CI on PR #232:
  unit (ubuntu, windows) and e2e green.

## Operational Verification

Risk surface: none

Not required: export runs on local files already recorded; the IPC round trip
exercises the real bundle writer against a temporary project.

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
| Clarify | no open questions; the one decision (a cross-target cast is labelled, never trimmed) is FR-002 | 2026-09-30 |
| Checklist | `checklists/requirements.md`: 5 items, all pass | 2026-09-30 |
| Analyze | 1 finding fixed: the domain contract did not mention attachments or exclusions (T004) | 2026-09-30 |
| Converge | 0 findings | 2026-09-30 |
