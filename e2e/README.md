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

**For source journeys, use `npm run e2e`.** The `pree2e` script rebuilds
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

Installed-only runs use the package's own native modules. With
`REDLOG_PACKAGED_APP` set, the documented direct Playwright command does not
need to rebuild workspace SQLite unless another selected spec launches source.

For the bounded settings/source/export check, use the two-file selection in
[Testing RedLog](../docs/TESTING.md#local-iteration-and-process-reuse). Ordinary
settings cases share an app and use separate projects; `export-preview` includes
source connection before export. IPC fault injection stays isolated. Avoid
running an unchanged journey once for source and again for package by default.

Non-HUD journeys using `launchWithTempHome` suppress automatic HUD display only
in the E2E process. HUD acceptance opts in with
`launchWithTempHome(executablePath, { showHud: true })`; direct HUD-specific
launches retain their normal display. The app's HUD default stays on and the
project config is not changed by this fixture.

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

## Placing a seeded event in time

A seed left at receipt time lands in the same 14-pixel cluster bucket as the
project's own genesis rows, and the timeline draws the bucket as one counted
node — `(3 events)` — whose label no longer contains the title the spec is
looking for. The event is there; no per-event locator can reach it. Three
specs failed this way on Windows while CI stayed green, because how many rows
share a bucket depends on the startup event mix and the render density.

Give anything you intend to locate by title its own place in time:

- **markers** — `data.atTimestamp`. Display only: the row keeps its real
  timestamp, and `displayTs` honours the override for `agent_type: 'marker'`
  and nothing else.
- **everything else** — `data.source_timestamp`. `insertEvent` validates it
  (a finite number, not before 2015, not more than a minute ahead) and writes
  it as the row's real timestamp, keeping the raw candidate in `ts_source`. A
  rejected value falls back to receipt time and says so inside the hash.

Two minutes of separation is enough at the usual zooms. `atTimestamp: now` is
the shape to look for when a per-event locator finds nothing.

## What does not run where

A green local run is not full coverage. These are skipped by platform:

| Spec | Skipped unless | Why |
|---|---|---|
| `external-session.spec.ts` | POSIX | the PTY launcher is POSIX-only |
| `managed-http-capture.spec.ts` | POSIX | its mitmdump stand-in is a `#!/bin/sh` script |
| `packaged-session-smoke.spec.ts`, `packaged-command-integrity.spec.ts` | POSIX, Zsh and `REDLOG_PACKAGED_APP` | actual installed package; Linux install CI and macOS acceptance exercise them |
| `packaged-nc-upgrade.spec.ts` | Linux and `REDLOG_PACKAGED_APP` | traditional netcat and real PTY job control |
| `packaged-dependency-install.spec.ts` | macOS, installed package and `REDLOG_PACKAGED_INSTALL_DEPS=1` | explicitly downloads and installs public dependencies |
| `export-preview.spec.ts` (write-permission case) | POSIX | real directory permissions; Windows ACL acceptance is separate |

HUD geometry has no permanently skipped case. Platform skips are prerequisites,
not successful acceptance; use the appropriate installed OS before trusting a
change to these paths.

## Layout verification

Use `first-run` for partial setup at wide/narrow sizes, `ui-closeout` and
`capture-settings-interaction` for settings, `export-preview` for dialog bounds,
keyboard focus and unobstructed actions, and `hud-overlay` for the floating bar.
Pure time-map/zoom tests own the math; source wiring checks do not prove layout.
Also resize the native app and inspect wrapping, scrolling and primary actions:
CDP clicks and jsdom cannot establish native hit testing or visual quality.

## CI

`.github/workflows/ci.yml` has an `e2e` job: `runs-on: ubuntu-latest`,
`needs: unit`, and it runs `xvfb-run --auto-servernum npm run e2e` against a
fresh build, uploading `e2e/screenshots/` as artifacts on failure.

`needs: unit` is the part worth remembering: **e2e does not run when an earlier
gate fails — it is skipped, not queued.** A branch can therefore accumulate
contract changes that e2e has never once checked. Before a large branch goes
up, run it locally.

## macOS launch environment

Run Electron in a normal desktop environment. Under an agent's restricted
sandbox, AppKit can abort before application code runs; see `AGENTS.md` for
the launch permission requirement. A missing first window does not establish
an Accessibility permission problem. Test real capture/privacy prompts
separately; do not grant extra OS permissions to mask a pre-launch failure.
