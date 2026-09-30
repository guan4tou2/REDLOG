# Verification: Capture Browser Silence

## RED

- Measured before the change: 9 requests in 45 s idle (field-trial search
  prefetch included), then 8 in 60 s after PR #232 (ListAccounts x5, GCM
  check-in x2, `/async/folae`, plus a www.google.com preconnect).
- Re-run on 2026-09-30 against `73fe520^1` with the tests from `73fe520`:
  `test/browser-launcher.test.ts` 2 failed, "routes through the proxy and does
  not exempt loopback" (no `redlog-offline.invalid` bypass) and "sends the
  services no switch disables to a host that never resolves (#182)" (no
  `PreconnectToSearch`).

## GREEN

- On main `2f995b4`: `browser-launcher` 17 pass.
- Idle probe with the exact `buildArgs` output: 0 requests in 60 s; a
  loopback page load is captured.
- Full vitest 2862 pass; the 5 failing files are the environment-only ones.
- CI on PR #233 green.

## Operational Verification

Risk surface: capture

Sections of RELEASE-SMOKE-TEST.md run, and the result: none as a section. The
60 s idle probe above ran the real Chromium with the real arguments behind
mitmproxy. The packaged build is still to be checked in the release smoke (#226).

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
| Clarify | 1 decision: keep omnibox search, so `/async/folae` is stopped by feature switches, not `--google-base-url` (FR-004) | 2026-09-30 |
| Checklist | `checklists/requirements.md`: 4 items, all pass | 2026-09-30 |
| Analyze | no findings | 2026-09-30 |
| Converge | 0 findings | 2026-09-30 |
