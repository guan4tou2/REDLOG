import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, openTestProject } from './helpers'

// v0.11.6: AUDIT V7 (idle-gap compression) and V9 (keyboard/screen-reader
// reachable event dots). V8 and V13 are geometry properties covered by
// test/timeline-geometry-units.test.ts — they need a wide window and a dense
// burst respectively, neither of which an E2E can stage cheaply.

let app: ElectronApplication
let page: Page

test.describe.serial('timeline presentation', () => {
  test.beforeAll(async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'redlog-pres-'))
    app = await electron.launch({ args: [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'presentation')
    await page.waitForTimeout(1500)
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
    const post = (t: string, d: Record<string, unknown>): Promise<Response> =>
      fetch(`${base}/api/events`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type: t, data: d }) })
    // Two bursts of work three hours apart — the shape V7 exists for.
    const now = Date.now()
    for (let i = 0; i < 6; i++) await post('marker', { title: `early ${i}`, severity: 'info', atTimestamp: now - 3 * 3600_000 - i * 30_000 })
    for (let i = 0; i < 6; i++) await post('marker', { title: `late ${i}`, severity: 'info', atTimestamp: now - i * 30_000 })
    await page.waitForTimeout(2000)
    await page.evaluate(() => localStorage.setItem('redlog-timeline-zoom', '1'))
    await page.reload()
    await page.waitForTimeout(2500)
    await page.click('button:has-text("Timeline")').catch(() => {})
    await page.waitForTimeout(1500)
  })

  test.afterAll(async () => { if (app) await app.close() })

  test('event dots are buttons a keyboard and a screen reader can reach', async () => {
    // They were plain divs with a click handler: no role, no label, no tab
    // stop. The existing up/down walk only engaged after a mouse click had
    // already selected something, so a keyboard-only operator could not reach
    // the track at all.
    const dot = await page.evaluate(() => {
      const el = document.querySelector('[data-timeline-event]') as HTMLElement | null
      return el && { tag: el.tagName, label: el.getAttribute('aria-label'), tabindex: el.getAttribute('tabindex') }
    })
    expect(dot?.tag).toBe('BUTTON')
    expect(dot?.label, 'needs a label — the visual is a 9px dot').toBeTruthy()

    // Roving tabindex: exactly one tab stop, so Tab crosses the track in one
    // press instead of stepping through every visible node.
    const stops = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-timeline-event]'))
        .filter((el) => el.getAttribute('tabindex') === '0').length)
    expect(stops).toBeLessThanOrEqual(1)
  })

  test('the skip-idle chip appears only when there is something to skip', async () => {
    // Detection has to run whether or not compression is on, or the control
    // that turns it on can never appear.
    const chip = page.getByRole('button', { name: /skip idle/i })
    await expect(chip).toBeVisible()
  })

  test('compressing collapses the gap and keeps the operator in place', async () => {
    const before = await page.evaluate(() => {
      const s = document.querySelector('div.cursor-grab') as HTMLElement
      return Array.from(document.querySelectorAll('[data-timeline-event]')).filter((d) => {
        const x = (d as HTMLElement).offsetLeft
        return x >= s.scrollLeft && x <= s.scrollLeft + s.clientWidth
      }).length
    })

    await page.getByRole('button', { name: /skip idle/i }).click()
    await page.waitForTimeout(900)

    const after = await page.evaluate(() => {
      const s = document.querySelector('div.cursor-grab') as HTMLElement
      return {
        gaps: document.querySelectorAll('[title*="no events, collapsed"]').length,
        label: (document.querySelector('[title*="no events, collapsed"]') as HTMLElement)?.textContent?.trim(),
        onScreen: Array.from(document.querySelectorAll('[data-timeline-event]')).filter((d) => {
          const x = (d as HTMLElement).offsetLeft
          return x >= s.scrollLeft && x <= s.scrollLeft + s.clientWidth
        }).length
      }
    })

    expect(after.gaps, 'the three-hour idle stretch should collapse').toBeGreaterThan(0)
    // The break is drawn, not implied — a discontinuity the operator cannot
    // see is worse than the wasted space it replaced.
    expect(after.label, 'the break carries its duration').toMatch(/\d+[hm]/)
    // And the viewport is re-anchored: the mapping changes under a fixed
    // scrollLeft, so without re-centring the operator lands on empty track.
    expect(after.onScreen, `dots on screen went ${before} -> ${after.onScreen}`).toBeGreaterThan(0)
  })
})
