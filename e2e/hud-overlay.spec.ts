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

  // Characterisation, not a fix. v0.9.4 changed the x rule to anchor to the
  // nearer display edge so width changes were symmetric; the operator reported
  // that the v0.9.3 HUD was correct and the new one was not, so the handler
  // was reverted verbatim. This test now records what v0.9.3 actually does, so
  // any future change to it is a deliberate one. The leftward drift it pins
  // down is tracked in docs/AUDIT-2026-08-08.md rather than patched blind.
  test('v0.9.3 behaviour: widening slides x left and narrowing does not restore it', async () => {
    const start = await bounds(app)

    await autosize(hud, 58, 720)
    const wide = await bounds(app)
    expect(wide.width).toBe(720)
    expect(wide.x, 'widening slides the HUD left to keep it on screen').toBeLessThan(start.x)

    await autosize(hud, 58, 440)
    const back = await bounds(app)
    expect(back.width).toBe(440)
    expect(back.x, 'v0.9.3 leaves x where widening put it').toBe(wide.x)
  })

  test.skip('content still fits at HUD scale 1.5 with emphasised IP', async () => {
    // SKIPPED: the fix for this raised the width ceiling above 720px, which
    // was part of the v0.9.4 HUD change the operator reported as wrong. The
    // clipping at scale 1.5 is real but is filed rather than patched — see
    // docs/AUDIT-2026-08-08.md. Re-enable alongside a verified fix.
    // The widest configuration the Settings UI can produce. Content alone
    // needs ~726px here, which the hard 720px ceiling clips.
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

// v0.9.7 regression: the v0.9.4 width fix measured `scrollWidth` on a flex
// row, whose content stretches to the container — so scrollWidth tracked
// clientWidth and each render asked for 8px more than the last. The window
// ran away to the clamp ceiling and the x anchoring slid with it.
test.describe.serial('HUD size stability', () => {
  let app2: ElectronApplication
  let hud2: Page

  test.beforeAll(async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'redlog-hud2-'))
    app2 = await electron.launch({
      args: [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' }
    })
    const main = await app2.firstWindow()
    await main.waitForLoadState('domcontentloaded')
    await openTestProject(main, 'hud-stability')
    await main.waitForTimeout(2500)
    hud2 = app2.windows().find((w) => w.url().includes('overlay'))!
  })

  test.afterAll(async () => { if (app2) await app2.close() })

  test('the HUD settles instead of growing on every render', async () => {
    const read = async (): Promise<{ x: number; width: number; height: number }> =>
      app2.evaluate(async ({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('overlay'))!
        const b = w.getBounds()
        return { x: b.x, width: b.width, height: b.height }
      })

    const first = await read()
    // Force a burst of re-renders — every one fires the autosize effect.
    for (let i = 0; i < 8; i++) {
      await hud2.evaluate(() => window.dispatchEvent(new Event('resize')))
      await hud2.waitForTimeout(120)
    }
    const after = await read()

    expect(after.width, `width drifted ${first.width} -> ${after.width} across renders`).toBe(first.width)
    expect(after.height, `height drifted ${first.height} -> ${after.height}`).toBe(first.height)
    expect(after.x, `x drifted ${first.x} -> ${after.x}`).toBe(first.x)
  })

  // v0.11.1: the expanded panel's label column was a hard 70px while its
  // labels render at fs(11) — "Last check" sat on the boundary at scale 1 and
  // wrapped to two lines, and every label wrapped at scale 1.25+. The column
  // now scales with the type. This checks the geometry rather than a
  // screenshot: a wrapped row is exactly twice the height of an unwrapped one.
  test('expanded panel labels stay on one line at every offered HUD scale', async () => {
    const main2 = app2.windows().find((w) => !w.url().includes('overlay'))!
    for (const scale of [1.0, 1.25, 1.5]) {
      await main2.evaluate(async (sc) => {
        const api = (window as unknown as { redlog: { config: { get: () => Promise<Record<string, unknown>>; save: (c: unknown) => Promise<unknown> } } }).redlog.config
        const cfg = await api.get()
        await api.save({ ...cfg, overlay: { ...(cfg.overlay as Record<string, unknown> ?? {}), scale: sc } })
      }, scale)
      await hud2.waitForTimeout(500)
      await hud2.evaluate(() => {
        const el = Array.from(document.querySelectorAll('div')).find((d) => d.textContent?.trim() === '\u25bc') as HTMLElement | undefined
        el?.click()
      })
      await hud2.waitForTimeout(400)

      const wrapped = await hud2.evaluate(() => {
        const cells = Array.from(document.querySelectorAll('div')).find((d) =>
          getComputedStyle(d).display === 'grid' && d.children.length >= 8)
        if (!cells) return null
        return Array.from(cells.children).map((c) => {
          const el = c as HTMLElement
          const lh = parseFloat(getComputedStyle(el).lineHeight) || el.getBoundingClientRect().height
          return { text: el.textContent?.trim().slice(0, 14), lines: Math.round(el.getBoundingClientRect().height / lh) }
        }).filter((x) => x.lines > 1)
      })
      expect(wrapped, `labels wrapped at HUD scale ${scale}: ${JSON.stringify(wrapped)}`).toEqual([])
    }
    // Restore both the scale and the collapsed state. These specs run serially
    // against one app, so leaving the HUD expanded at scale 1.5 would fail the
    // compact-size check below for a reason that has nothing to do with what
    // it is testing.
    await hud2.evaluate(() => {
      const el = Array.from(document.querySelectorAll('div')).find((d) => d.textContent?.trim() === '\u25b2') as HTMLElement | undefined
      el?.click()
    })
    await main2.evaluate(async () => {
      const api = (window as unknown as { redlog: { config: { get: () => Promise<Record<string, unknown>>; save: (c: unknown) => Promise<unknown> } } }).redlog.config
      const cfg = await api.get()
      await api.save({ ...cfg, overlay: { ...(cfg.overlay as Record<string, unknown> ?? {}), scale: 1 } })
    })
    await hud2.waitForTimeout(500)
  })

  test('the collapsed HUD stays at its compact size', async () => {
    const b = await app2.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('overlay'))!
      return w.getBounds()
    })
    // Collapsed at scale 1 is a single row — 440px wide, well under 100px tall.
    // Runaway growth showed up here first as a window pinned near the cap.
    expect(b.width, 'collapsed HUD should be near its 440px base, not the ceiling').toBeLessThan(560)
    expect(b.height, 'collapsed HUD should be one row tall').toBeLessThan(120)
  })
})
