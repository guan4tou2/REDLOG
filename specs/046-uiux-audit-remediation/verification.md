# Verification: UI/UX Audit Remediation

## RED

Re-run on 2026-09-30 with each PR's new tests against the commit before it:

- `60e6d5e^1` (#234): 12 failed across `event-marker-save` (4),
  `failed-reads-not-safe` (3), `toast-cap` (3) and `i18n-terminology` (2):
  e.g. "keeps the dialog and the draft when the save fails", "shows scope as
  unknown when the rules cannot be read, never as in scope".
- `086979e^1` (#235): `modal.test.tsx` could not resolve `Modal`;
  `screenshot-not-redlog` 4 failed (`agent.holdFrame is not a function`;
  captured display 11, expected 21).
- `2f995b4^1` (#236): `design-palette` 2 failed (197 undefined shades, 2 files
  with stray hex); `button-names` 1 failed (3 unnamed buttons).

## GREEN

- On main `2f995b4`: those 9 files plus `design-tokens` and `shortcuts` pass:
  11 files, 61 tests.
- Full vitest 2862 pass; the 5 failing files are the environment-only ones.
- Typecheck, `verify:architecture`, `verify:specs` pass; CI (unit on ubuntu
  and windows, e2e) green on #234, #235 and #236.

## Operational Verification

Risk surface: capture (screenshots)

Sections of RELEASE-SMOKE-TEST.md run, and the result: none. The held frame,
window hiding and cursor display are covered by `screenshot-not-redlog` with
a stubbed capturer; a real multi-display capture is for the release smoke (#226).

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
| Clarify | 1 answered in chat: do both batches ("都做"); leftovers named in Out of Scope | 2026-09-30 |
| Checklist | `checklists/requirements.md`: 5 items, all pass | 2026-09-30 |
| Analyze | 1 finding: the audit's 12px-text item was false (`--text-xs` is 13px); dropped | 2026-09-30 |
| Converge | 2 items outside this spec, recorded in Out of Scope, no tasks appended | 2026-09-30 |
