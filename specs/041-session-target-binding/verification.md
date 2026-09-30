# Verification: Session Target Binding

## RED

Re-run on 2026-09-30 against `b325069^1` with the tests from `b325069`:

- `test/ingest.test.ts`: `Cannot find module '/src/core/session-targets'`;
  "attributes by session target before the global one, in two parallel panes"
  and "takes an external shell's own REDLOG_TARGET over the global target"
  failed (`expected '10.10.11.99' to be '10.10.11.8'`).
- `test/session-target-control.test.tsx`: `SessionTargetControl` did not exist.

## GREEN

- On main `2f995b4`: `ingest` 14 and `session-target-control` 1 pass.
- Full vitest 2862 pass; the 5 failing files are the environment-only ones
  that fail on main alike (node-pty, Python cffi).
- Typecheck, `verify:architecture`, `verify:specs` pass; CI on PR #232 green.

## Operational Verification

Risk surface: capture

Sections of RELEASE-SMOKE-TEST.md run, and the result: none.

Not required for Verified: attribution is decided at ingest, which the tests
drive with real events. The `REDLOG_TARGET` path through a real hooked shell
is still to be exercised in the release smoke test.

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
| Clarify | no open questions; the decisions (rank below an enriched host, record changes without rewriting) are FR-001 and FR-003 | 2026-09-30 |
| Checklist | `checklists/requirements.md`: 5 items, all pass | 2026-09-30 |
| Analyze | 1 finding fixed: the domain precedence line omitted the session target (T004) | 2026-09-30 |
| Converge | 0 findings | 2026-09-30 |
