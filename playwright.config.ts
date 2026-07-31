import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  // No `webServer` — Electron is launched inside each test via
  // `_electron.launch(...)`, not by Playwright's dev-server helper.
})
