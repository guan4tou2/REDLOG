# Verification: Recording-first setup

## RED

- `test/command-evidence.test.ts`: three failures before the project evidence
  query existed. Cases: older command behind 25 markers/session ends, activation
  versus actual command, different project database. SQLite executed normally.
- `test/first-run-record-terminal.test.tsx -t 'project command proof'`: two
  failures (historical proof and recoverable proof-query rejection) before the
  renderer read the separate project summary.
- HTTPS selection: three expected failures before implementation (HTTP-only,
  HTTPS without HTTP, removal of the separate HTTP checklist row).
- External-first fallback and optional-web preparation: tests recorded first.

## GREEN

2026-10-17, macOS, full unit suite outside the sandbox: 356 files passed,
4 skipped; 3628 tests passed, 24 skipped, 0 failed. typecheck, verify:specs,
verify:architecture and verify:i18n passed. This is not release acceptance.

Two defects found while integrating, both fixed:

- `first-run-record-terminal`: the verified-state test sent an event without
  `shell`; the connection check now requires it to match the selected adapter,
  so the test event carries `shell: 'zsh'`.
- WSL: the renderer required `wsl_distro` on the event but no hook emitted it,
  so a WSL target could never verify. Both payload builders in
  `hooks/shell-common.sh` now send it (`shell-payload-fast`, WSL case).

## Operational Verification

Risk surface: capture setup / external integration.
Electron: `e2e/first-run.spec.ts` and `e2e/managed-http-capture.spec.ts`,
13 passed on macOS. Not run: packaged build, Windows, WSL, Kali, PowerShell
on a real host. The PowerShell hook does not send `wsl_distro`; WSL is POSIX
shells only.

## Release Impact

| | |
|---|---|
| User-visible | yes |
| Breaking | setup presentation and verification semantics |
| Packaging affected | no resource layout change |
| CHANGELOG updated | pending |
| Upgrade note required | no hook path change |
| Packaged smoke required | before release; not yet run for this change |

## Gates

| Gate | Result | Date |
|---|---|---|
| Clarify | User approved external-first, three adapters, optional web | 2026-10-17 |
| Checklist | Pending final scope check | |
| Analyze | Pending patch review | |
| Converge | Pending integration | |
