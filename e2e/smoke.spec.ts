import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(__dirname, '..')
const MAIN_ENTRY = join(REPO_ROOT, 'out', 'main', 'index.js')
const SCREENSHOT_PATH = join(__dirname, 'screenshots', 'smoke.png')

test('app launches and shows the RedLog window', async () => {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(
      `Electron build output not found at ${MAIN_ENTRY}. ` +
        `Run "npm run build" before "npm run e2e".`
    )
  }

  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({
      args: [MAIN_ENTRY],
      cwd: REPO_ROOT,
      // Some CI/headless envs need this; harmless locally.
      env: { ...process.env, NODE_ENV: 'test' }
    })

    const window: Page = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    // index.html sets <title>RedLog</title>; the main process does not
    // override BrowserWindow.title, so document.title wins.
    const title = await window.title()
    expect(title).toContain('RedLog')

    mkdirSync(dirname(SCREENSHOT_PATH), { recursive: true })
    await window.screenshot({ path: SCREENSHOT_PATH })
  } finally {
    if (app) await app.close()
  }
})
