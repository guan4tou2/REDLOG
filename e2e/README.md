# RedLog E2E tests

Playwright-driven end-to-end tests that boot the built Electron app via
`_electron.launch` and drive its real windows. Separate from the vitest unit
suite under `test/`.

## Running locally

```sh
npm install          # first time only — pulls @playwright/test
npm run build        # produces out/main/index.js (required)
npm run e2e          # runs e2e/*.spec.ts headlessly
npm run e2e:ui       # opens Playwright's UI mode for interactive debugging
```

The tests spawn the packaged main process at `out/main/index.js`. If that
file doesn't exist the smoke test fails with a message telling you to run
`npm run build` first — there is no auto-build step.

## What's covered

- `smoke.spec.ts` — launches the app, waits for the first `BrowserWindow`,
  asserts the window title contains `RedLog`, screenshots to
  `e2e/screenshots/smoke.png`, and shuts the app down cleanly.

That's the whole suite for now. Add more `*.spec.ts` files under `e2e/` as
needed; Playwright picks them up via `playwright.config.ts`.

## CI

Not wired into GitHub Actions yet — that's a follow-up task. The e2e script
is deliberately kept out of `npm test` so unit tests stay fast and headless.

## macOS gotcha

The first time the built app runs on macOS it may prompt for Accessibility
permission (the app uses global shortcuts / overlay windows). Grant it in
System Settings, or the test may hang on `firstWindow()` waiting for the
window to actually appear. Subsequent runs are unaffected.
