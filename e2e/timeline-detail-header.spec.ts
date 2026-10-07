import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, makeTempHome, openTestProject, openView } from './helpers'

// The detail pane's top row carries the ways out of an event — step to the
// previous or next one, ask what else was running around it, exclude it from
// the export. The pane scrolls, and the row used to scroll with it: read past
// the first screen and stepping meant scrolling back up to find the control.
//
// Every measurement here is a client rect. Mixing them with `offset*` under
// `body { zoom }` compares device pixels against CSS ones (CLAUDE.md).

let app: ElectronApplication
let page: Page

test.describe.serial('timeline detail header', () => {
  test.beforeAll(async () => {
    const tmpHome = makeTempHome('redlog-detail-header-')
    app = await electron.launch({ args: [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'detail-header')

    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
    // Far enough apart not to cluster: neighbouring events collapse into one
    // dot labelled "(2 events)", which no per-event locator can reach. That
    // holds for the project's own genesis rows too — they land at receipt
    // time, so a seed left at `now` clusters with them and the per-event
    // locator finds nothing.
    const now = Date.now()
    const when = { 'first event': now - 7_200_000, 'header pin event': now - 120_000 }
    for (const [title, atTimestamp] of Object.entries(when)) {
      await fetch(`${base}/api/events/seed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type: 'marker', data: { subtype: 'created', title, atTimestamp } })
      })
    }
    await openView(page, 'timeline')
    await page.waitForTimeout(1500)
  })

  test.afterAll(async () => { if (app) await app.close() })

  test('keeps the step and export controls on screen while the pane scrolls', async () => {
    await page.locator('[data-timeline-event][aria-label*="header pin event"]').first().click()
    const panel = page.getByTestId('timeline-detail-panel')
    await expect(panel).toBeVisible()
    await expect(page.getByTestId('detail-step-prev')).toBeVisible()

    // Where the control ends up, not how it was pinned. `sticky`, or a header
    // lifted out of the scrolling body, or anything else — this asks only
    // whether the operator can still reach it from the bottom of the pane.
    const pinned = await page.evaluate(() => {
      const pane = document.querySelector('[data-testid="timeline-detail-panel"]') as HTMLElement
      const step = document.querySelector('[data-testid="detail-step-prev"]') as HTMLElement
      // If there is nothing to scroll, the row cannot have gone anywhere and
      // this would pass for the wrong reason. Report it rather than assert.
      const room = pane.scrollHeight - pane.clientHeight
      pane.scrollTop = room
      const p = pane.getBoundingClientRect()
      const s = step.getBoundingClientRect()
      return { room, scrolled: pane.scrollTop, aboveTop: p.top - s.top, belowBottom: s.bottom - p.bottom }
    })

    expect(pinned.room, 'the pane has nothing to scroll, so this proves nothing').toBeGreaterThan(20)
    // Inside the pane's visible box, within a pixel of rounding, after
    // scrolling to the very end.
    expect(pinned.aboveTop).toBeLessThan(2)
    expect(pinned.belowBottom).toBeLessThan(2)
    // And usable where it sits, not merely painted there.
    await expect(page.getByTestId('detail-around-event')).toBeVisible()
  })
})
