import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, openTestProject } from './helpers'

// HUD overlay geometry. The window sizes itself from `overlay:autosize`, which
// the renderer fires on every layout-affecting render. Both halves of that
// contract have bitten operators: the reported width is a formula rather than a
// measurement, and the main-side x correction was one-directional.

let app: ElectronApplication
let hud: Page
let main: Page

async function bounds(a: ElectronApplication): Promise<{ x: number; width: number }> {
  return a.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('overlay'))!
    const b = w.getBounds()
    return { x: b.x, width: b.width }
  })
}

async function autosize(page: Page, h: number, w: number): Promise<void> {
  await page.evaluate(([hh, ww]) => {
    ;(window as unknown as { redlog: { overlay: { autosize: (h: number, w?: number) => void } } })
      .redlog.overlay.autosize(hh, ww)
  }, [h, w])
  await page.waitForTimeout(250)
}

test.describe.serial('HUD overlay geometry', () => {
  test.beforeAll(async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'redlog-hud-'))
    app = await electron.launch({
      args: [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' }
    })
    main = await app.firstWindow()
    await main.waitForLoadState('domcontentloaded')
    await openTestProject(main, 'hud-geom')
    await main.waitForTimeout(2000)
    hud = app.windows().find((w) => w.url().includes('overlay'))!
    expect(hud, 'overlay window never opened').toBeTruthy()
  })

  test.afterAll(async () => { if (app) await app.close() })

  test('widening then narrowing returns the HUD to its original x', async () => {
    const start = await bounds(app)

    // Grow to the clamp ceiling — this pushes x left to keep the HUD on screen.
    await autosize(hud, 58, 720)
    const wide = await bounds(app)
    expect(wide.width).toBe(720)
    expect(wide.x, 'widening should slide the HUD left').toBeLessThan(start.x)

    // Shrink back. The HUD was anchored at the right edge, so it must return.
    await autosize(hud, 58, 440)
    const back = await bounds(app)
    expect(back.width).toBe(440)
    expect(back.x, 'narrowing must restore x — otherwise the HUD drifts left on every scale change')
      .toBe(start.x)
  })

  test('content still fits at HUD scale 1.5 with emphasised IP', async () => {
    // The widest configuration the Settings UI can produce. Content alone
    // needs ~726px here, which the old hard 720px ceiling clipped.
    await main.evaluate(async () => {
      const api = (window as unknown as { redlog: { config: { get: () => Promise<Record<string, unknown>>; save: (c: unknown) => Promise<unknown> } } }).redlog.config
      const cfg = await api.get()
      const ov = (cfg.overlay ?? {}) as Record<string, unknown>
      await api.save({ ...cfg, overlay: { ...ov, scale: 1.5, emphasizeExternalIp: true } })
    })
    await hud.waitForTimeout(700)

    const b = await bounds(app)
    expect(b.width, 'window should be allowed past the old 720px cap').toBeGreaterThan(720)

    const fit = await hud.evaluate(() => {
      const inner = document.getElementById('root') as HTMLElement
      return { need: inner.scrollWidth, have: document.documentElement.clientWidth }
    })
    expect(fit.need, `content needs ${fit.need}px, window is ${fit.have}px — clipped`)
      .toBeLessThanOrEqual(fit.have)
    await hud.screenshot({ path: 'e2e/screenshots/hud-scale-1.5.png' })
  })

  test('reported width covers the rendered content', async () => {
    const fit = await hud.evaluate(() => {
      // The measured element is the one autosize reports on.
      const el = document.querySelector('#root > div > div > div > div:last-child') as HTMLElement | null
      const inner = el ?? (document.getElementById('root') as HTMLElement)
      return { need: inner.scrollWidth, have: document.documentElement.clientWidth }
    })
    expect(fit.need, `content needs ${fit.need}px but the window is ${fit.have}px — it is being clipped`)
      .toBeLessThanOrEqual(fit.have)
  })
})
