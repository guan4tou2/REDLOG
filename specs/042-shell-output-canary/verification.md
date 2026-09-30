# Verification: Shell Output Canary

## RED

Re-run on 2026-09-30 against `b325069^1` with the tests from `b325069`:

- `test/output-canary.test.ts`: `Cannot find module '../src/renderer/src/lib/outputCanary'`.
- `test/first-run-record-terminal.test.tsx`: "verifies output only when the
  canary text arrives in stdout, and says when only metadata did" failed.
- `test/external-session.test.ts`: "refuses to start a second recorder inside
  a session, unless --nested" failed (`expected 1 to be 2`).
- PTY size: before the fix, `stty size` as the first command printed `0 0`;
  the interrupt test failed 2 of 6 runs under CPU load (exit 143).

## GREEN

- On main `2f995b4`: `output-canary` 4, `external-session` 8 and
  `first-run-record-terminal` pass. After the PTY fix, 15 of 15
  `external-session` runs and 20 of 20 `stty size` runs pass under the same load.
- Full vitest 2862 pass; the 5 failing files are the environment-only ones.
- Typecheck, `verify:architecture`, `verify:specs` pass; CI on PR #232 green.

## Operational Verification

Risk surface: capture

Sections of RELEASE-SMOKE-TEST.md run, and the result: none. The new
output-check, tmux, ssh/nc, Ctrl-C, restart, pause and cap steps need a real
machine and are open for the next release smoke (#226).

Not required for Verified: the recorder is exercised end to end by
`external-session.test.ts` through a real PTY.

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
| Clarify | no open questions; the `--nested` override (FR-003) covers a tmux server that outlived its session | 2026-09-30 |
| Checklist | `checklists/requirements.md`: 5 items, all pass | 2026-09-30 |
| Analyze | no findings | 2026-09-30 |
| Converge | 0 findings | 2026-09-30 |
