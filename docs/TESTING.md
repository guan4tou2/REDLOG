# Testing RedLog

Use the smallest test layer that proves the behavior. The current suites are
`test/` (Vitest) and `e2e/` (Playwright/Electron); installed-package journeys
reuse `e2e/` against an actual executable. Historical results are not new runs.

## Commands

Run the repository gates in this order before pushing:

```sh
git fetch origin main
npm run typecheck
npm run verify:specs
npm run verify:architecture
npm run verify:i18n
npm test
npm run build
```

`npm test` rebuilds SQLite for Node, then runs Vitest. `npm run e2e` rebuilds it
for Electron. Do not run these concurrently. A subsequent `npm test` restores
a Node rebuild. If the binding still fails, check the rebuild log, node-gyp
selection and headers before changing product code or skipping database tests.

| Purpose | Command | What it proves |
| --- | --- | --- |
| One behavior | `npx vitest run test/<file>.test.ts` | The selected domain, storage or rendered behavior; native modules must already use the Node ABI. |
| Local iteration | `npm run test:watch` | Vitest watch mode; same ABI requirement. |
| Source app journey | `npm run build` then `npm run e2e -- e2e/<file>.spec.ts` | Real Electron/IPC interaction with isolated test homes. |
| Whole source journey suite | `npm run e2e` | All source journeys; explicit platform/installed-only skips remain skips. |
| Package contents/signature | `npm run verify:package-resources` after packaging | Shipped adapters, verifier, manifests and macOS resource seal. |
| Installed app | Set `REDLOG_PACKAGED_APP` and run the relevant `e2e/packaged-*.spec.ts` | The actual installed executable and shipped resources. |
| Strict installation result | `node scripts/verify-smoke-report.mjs <report.json>` | Every selected test passed, with no skip, flaky result or `not-exercised` annotation. |
| Release asset contract | `RELEASE_TAG=v<version> node scripts/verify-release-assets.mjs <directory>` | All versioned installers and Windows updater metadata match the actual files. |

For an installed smoke, keep the JSON report outside Playwright's output folder
so a following invocation cannot clear it:

```sh
REDLOG_PACKAGED_APP='/absolute/path/to/RedLog' \
PLAYWRIGHT_JSON_OUTPUT_NAME='/absolute/path/to/smoke.json' \
npx playwright test e2e/packaged-smoke.spec.ts --reporter=list,json
node scripts/verify-smoke-report.mjs /absolute/path/to/smoke.json
```

## Coverage owners

| Requirement | Primary tests |
| --- | --- |
| Plain Zsh command/output/exit and terminal behavior | `zsh-auto-capture.pty`, `zsh-engagement-100.pty`, `zsh-transparency.pty`, `relay-pty-boundary` |
| Hook transport, identity, spool and outages | `shell-*`, `spool-replay`, `per-project-token`, `powershell-*` |
| Capture setup, preparation/cancel and recovery | `capture-preparation`, `first-run`, `terminal-enrollment`, `dependency-cancel` |
| HTTP readiness, actual requests and proof | `managed-proxy-readiness`, `http-verification`, `managed-http-capture`, `packaged-smoke` |
| Query/filter/export and evidence integrity | `query-*`, `export-plan*`, `filtered-export`, `redlog-verify`, `packaged-smoke` |
| Project/pane isolation and saved recordings | `terminal-session-rotation`, `packaged-session-smoke`, `packaged-command-integrity` |
| UI tokens/contrast | `design-tokens` owns numerical contrast; `design-rules`/`design-palette` own source conventions. |
| Plugin manifests/contributions/trust | `plugins`, `starter-pack`, `builtin-tools-pack` |

File stems refer to `test/*.test.ts(x)` unless a journey is under `e2e/`.
Producer tests must compare real command output, exits and artifacts. Seeded
UI events prove rendering and interaction, not producer coverage.

## CI and platforms

- CI runs the five gates and build on Linux, Windows and macOS; Electron source
  journeys run on Linux. A green Linux result does not prove macOS PTY behavior.
- Linux package smoke installs/removes the x64 DEB and checks real capture,
  HTTP(S), export/restart and cancellation. Windows smoke installs/removes NSIS
  and checks native PowerShell plus capture/export. Both require strict JSON.
- Installed-only, native WSL, performance and public dependency-download tests
  have explicit prerequisites/opt-ins. Do not delete them merely because a
  source-only run skips them, or count them as passed.
- Manual download, desktop launch, trust prompts and first-install friction use
  [the release walkthrough](RELEASE-SMOKE-TEST.md). Exact prior package results
  and remaining limitations are in [the package matrix](PACKAGED-SMOKE.md).

## Keep the suite focused

Prefer observable behavior over assertions about source spelling. Keep unique
regressions for lost evidence, wrong attribution, privacy and terminal control.
Remove a duplicate only after identifying its retained coverage owner. An
obsolete requirement belongs in history, not a permanently skipped runnable
test. UI snapshots and a window opening do not prove successful recording.

The former Part 1–6 option/audit matrix (including G-* references in historical
tests/specs) is [archived](archive/TEST-MATRIX-2026-10-16.md). It is not the
current procedure or an assertion that those historical gaps remain open.
