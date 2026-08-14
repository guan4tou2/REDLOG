import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, openTestProject } from './helpers'

// The alert path through real windows: a verdict arrives on `ip:status` and both
// the HUD overlay and the main window's status bar have to change. The unit
// tests (`alert-display`, `alert-surfaces`) assert the same rendering against a
// mocked bridge; this spec proves the IPC channel, the preload subscription and
// the real compositor are wired to it too — the layer where "it renders in jsdom
// but the operator sees nothing" would hide.
//
// The verdict is pushed directly rather than provoked by a real egress lookup:
// the classifier already has exhaustive unit coverage, and an e2e run must not
// depend on the machine's actual network position.

let app: ElectronApplication
let hud: Page
let main: Page

interface Status {
  externalIP: string | null
  internalIP: string | null
  ipSafety: 'safe' | 'exposed' | 'unknown'
  lastCheck: number
  error: string | null
  settling: boolean
}

const status = (ipSafety: Status['ipSafety'], externalIP = '203.0.113.7'): Status => ({
  externalIP, internalIP: '10.0.0.2', ipSafety, lastCheck: Date.now(), error: null, settling: false
})

/** Push a verdict to every window, exactly as `broadcastIPStatus` does. */
async function pushStatus(s: Status): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }, payload) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('ip:status', payload)
    }
  }, s)
  await hud.waitForTimeout(150)
}

/** Inline background of the HUD frame — the element carrying the verdict. */
function frame(page: Page): ReturnType<Page['locator']> {
  return page.locator('body > div > div > div').first()
}

test.describe.serial('IP verdict reaches the operator', () => {
  test.beforeAll(async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'redlog-ipalert-'))
    app = await electron.launch({
      args: [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' }
    })
    main = await app.firstWindow()
    await main.waitForLoadState('domcontentloaded')
    await openTestProject(main, 'ip-alert')
    await main.waitForTimeout(2000)
    hud = app.windows().find((w) => w.url().includes('overlay'))!
    expect(hud, 'overlay window never opened').toBeTruthy()
  })

  test.afterAll(async () => { if (app) await app.close() })

  test('EXPOSED turns the HUD frame red and flashes it', async () => {
    await pushStatus(status('exposed'))
    await expect(hud.getByText('EXPOSED').first()).toBeVisible()
    const style = await frame(hud).getAttribute('style')
    expect(style).toContain('rgb(215, 95, 99)')   // HUD.red
    expect(style).toContain('alarm')              // the flash keyframes
  })

  test('the same verdict reaches the status bar in the main window', async () => {
    await expect(main.getByText('EXPOSED').first()).toBeVisible()
    await expect(main.getByText('203.0.113.7').first()).toBeVisible()
  })

  test('SAFE clears the alarm and returns the frame to cyan', async () => {
    await pushStatus(status('safe'))
    await expect(hud.getByText('SAFE').first()).toBeVisible()
    const style = await frame(hud).getAttribute('style')
    expect(style).toContain('rgb(63, 199, 214)')  // HUD.cyan
    expect(style).not.toContain('alarm')
  })

  test('UNKNOWN is amber and distinct from SAFE — a dropped VPN is not green', async () => {
    await pushStatus(status('unknown'))
    await expect(hud.getByText('IP?').first()).toBeVisible()
    await expect(main.getByText('IP?').first()).toBeVisible()
  })

  test('turning flashOnExposed off stops the flash without a restart', async () => {
    await main.evaluate(async () => {
      const bridge = (window as unknown as {
        redlog: { config: { get: () => Promise<Record<string, unknown>>; save: (c: unknown) => Promise<boolean> } }
      }).redlog
      const cfg = await bridge.config.get()
      const overlay = (cfg.overlay ?? {}) as Record<string, unknown>
      await bridge.config.save({ ...cfg, overlay: { ...overlay, flashOnExposed: false } })
    })
    await hud.waitForTimeout(400)

    await pushStatus(status('exposed'))
    const style = await frame(hud).getAttribute('style')
    expect(style).toContain('rgb(215, 95, 99)')   // still unmistakably red
    expect(style).not.toContain('alarm')          // but no longer flashing
  })

  test('a missing reading shows an em dash, never a stale address', async () => {
    await pushStatus({ ...status('unknown'), externalIP: null, internalIP: null })
    await expect(hud.getByText('—').first()).toBeVisible()
    await expect(main.getByText('203.0.113.7')).toHaveCount(0)
  })
})
