import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  // One worker at a time — the Electron main process holds a
  // requestSingleInstanceLock and binds port 6660 for the RedLog API, so two
  // parallel _electron.launch() calls step on each other.
  workers: 1,
  // No `webServer` — Electron is launched inside each test via
  // `_electron.launch(...)`, not by Playwright's dev-server helper.
})
