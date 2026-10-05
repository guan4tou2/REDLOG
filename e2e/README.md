# RedLog E2E tests

Playwright drives the **built** Electron app through `_electron.launch` and its
real windows. Separate from the vitest suite under `test/`, and deliberately
slower: one worker, because the main process holds a single-instance lock and
binds the RedLog API port, so two parallel launches step on each other.

## Running locally

```sh
npm run build        # produces out/main/index.js — the tests launch it and never build it
npm run e2e          # every e2e/*.spec.ts
npm run e2e:ui       # Playwright UI mode, for one spec at a time
```

**Use `npm run e2e`, not `npx playwright test`.** The `pree2e` script rebuilds
better-sqlite3 for Electron's ABI. `npx playwright test` goes straight to
Playwright and skips it, and the mismatch does not announce itself as an ABI
error: Electron dies mid-launch with `exitCode=3221225477` (0xC0000005) and the
failure surfaces as a missing `view-root` selector. If you need one spec
directly, do the rebuild yourself first:

```sh
npx electron-rebuild -f -o better-sqlite3
npx playwright test e2e/<spec>.spec.ts --reporter=line
```

Running `npm test` afterwards flips the module back to the Node ABI (its
`pretest` rebuilds), which is fine — but then the next direct Playwright run
needs the rebuild again.

## What it covers

One spec per journey, named for the journey: `first-run`, `project-flow`,
`recording-pause`, `scope-recompute`, `export-preview`, `http-history-view`,
`timeline-*`, and so on. `ls e2e/*.spec.ts` is the list; this file does not
repeat it, because the last copy of that list said the suite was one smoke
test long after it was thirty-seven files.

`helpers.ts` holds the shared launch: a temp `HOME`, a project opened through
the real UI, and view navigation. A spec that writes events posts them to the
running app's own `/api/events` with the token from the temp home, so the path
under test is the real ingest path.

## What does not run where

A green local run is not full coverage. These are skipped by platform:

| Spec | Skipped unless | Why |
|---|---|---|
| `external-session.spec.ts` | POSIX | the PTY launcher is POSIX-only |
| `managed-http-capture.spec.ts` | POSIX | its mitmdump stand-in is a `#!/bin/sh` script |
| `packaged-session-smoke.spec.ts` | macOS **and** `REDLOG_PACKAGED_APP` set | needs a freshly built `.app`; CI is ubuntu, so this one only ever runs by hand |
| `hud-overlay.spec.ts` (one case) | never | a filed clipping bug at HUD scale 1.5, skipped with its reason in the test |

On Windows, expect the first three to report as skipped. If you are changing
anything they cover, run them on Linux or macOS before trusting the result.

## CI

`.github/workflows/ci.yml` has an `e2e` job: `runs-on: ubuntu-latest`,
`needs: unit`, and it runs `xvfb-run --auto-servernum npm run e2e` against a
fresh build, uploading `e2e/screenshots/` as artifacts on failure.

`needs: unit` is the part worth remembering: **e2e does not run when an earlier
gate fails — it is skipped, not queued.** A branch can therefore accumulate
contract changes that e2e has never once checked. Before a large branch goes
up, run it locally.

## macOS gotcha

The first time the built app runs on macOS it may prompt for Accessibility
permission (global shortcuts, overlay windows). Grant it in System Settings, or
the test can hang on `firstWindow()` waiting for a window that never appears.
Subsequent runs are unaffected.
