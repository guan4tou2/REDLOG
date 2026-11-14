import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, openTestProject, openView, resizeMainWindow, resetTimelineZoom } from './helpers'

// Layout leftovers (owner, 2026-11-14): measured in a real window, not
// estimated. Three things a person sees:
//   1. at 800x500 the Activity page shows at least ACTIVITY_ROWS whole rows
//      with nothing scrolled;
//   2. at 800x500 and 1280x800 the first and last ruler labels lie wholly
//      inside the timeline pane;
//   3. on Targets, with enough rows to scroll, the header's right edge is the
//      cards' right edge.
//
// Geometry: every comparison is getBoundingClientRect() against
// getBoundingClientRect(), one family on both sides (CLAUDE.md). Nothing here
// is compared with an offset* value.
//
// ACTIVITY_ROWS is a measured floor, see the constant below. A derivation from
// class sizes predicted 5 and the real window showed 4 in this seeded state.
// Measured in a real macOS window, not derived: 4 in this seeded state (the
// tab row carries the live count and wraps), 5 with the visual-reference seed.
// It was 2 before the header was merged and the rows brought to --row-h.
const ACTIVITY_ROWS = 4

interface Box { left: number; right: number; top: number; bottom: number }

async function post(tmpHome: string, agent_type: string, data: Record<string, unknown>): Promise<void> {
  const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
  const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
  const r = await fetch(`${base}/api/events/seed`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ agent_type, data }) })
  expect(r.ok, `seed ${agent_type} ${String(data.command ?? '')}`).toBe(true)
}

/** Activity rows whose whole box is inside the results scroller and the view. */
async function activityRows(page: Page): Promise<{ visible: number; rows: number; scrolled: number; firstTop: number; scrollerBottom: number }> {
  return page.evaluate(() => {
    const scroller = document.querySelector('[data-testid="search-results"]') as HTMLElement | null
    const root = document.querySelector('[data-testid="view-root"]') as HTMLElement | null
    const rows = Array.from(document.querySelectorAll('[data-testid="activity-row"]')) as HTMLElement[]
    if (!scroller || !root) return { visible: 0, rows: rows.length, scrolled: -1, firstTop: 0, scrollerBottom: 0 }
    const box = scroller.getBoundingClientRect()
    const view = root.getBoundingClientRect()
    const visible = rows.filter((r) => {
      const b = r.getBoundingClientRect()
      return b.height > 0 && b.top >= box.top - 0.5 && b.bottom <= box.bottom + 0.5 && b.bottom <= view.bottom + 0.5
    }).length
    return { visible, rows: rows.length, scrolled: scroller.scrollTop, firstTop: rows[0]?.getBoundingClientRect().top ?? 0, scrollerBottom: box.bottom }
  })
}

/** The first and last ruler labels, and the pane they must stay inside. */
async function rulerEnds(page: Page): Promise<{ pane: Box; first: Box; last: Box; count: number }> {
  return page.evaluate(() => {
    const box = (el: Element): Box => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom } }
    const pane = document.querySelector('[data-testid="timeline-lane-scroll"]') as HTMLElement
    const labels = Array.from(document.querySelectorAll('[data-testid="timeline-axis-label"]'))
    return { pane: box(pane), first: box(labels[0]), last: box(labels[labels.length - 1]), count: labels.length }
  })
}

test('layout leftovers: activity rows at 800x500, ruler end labels, targets header edge', async () => {
  test.setTimeout(240_000)
  const { app, page, tmpHome } = await launchWithTempHome()
  try {
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'zh-TW'))
    await page.reload()
    await openTestProject(page, 'layout-leftovers')
    await page.waitForTimeout(1200)

    // Twelve commands in the last half hour (one day, so no separator falls
    // between rows), and thirty targets: more than one 800x500 screen of cards.
    const at = (minutesAgo: number): number => Date.now() - minutesAgo * 60_000
    for (let i = 0; i < 12; i++) {
      await post(tmpHome, 'shell', { subtype: 'command_end', command: `echo row-${i}`, exit_code: 0, source_timestamp: at(30 - i * 2) })
    }
    for (let i = 0; i < 30; i++) {
      await post(tmpHome, 'shell', { subtype: 'command_start', detectedTarget: `host-${i}.example`, command: `curl https://host-${i}.example/`, source_timestamp: at(5) })
    }
    await page.waitForTimeout(1500)

    // (1) Activity at the smallest window the app allows.
    await resizeMainWindow(app, 800, 500)
    await openView(page, 'search')
    await expect(page.getByTestId('activity-row').first()).toBeVisible()
    await page.waitForTimeout(600)
    const rows = await activityRows(page)
    expect(rows.scrolled, 'nothing may be scrolled to reach the rows').toBe(0)
    expect(rows.visible, `activity rows fully visible at 800x500: ${rows.visible} of ${rows.rows} (first row top ${rows.firstTop}, scroller bottom ${rows.scrollerBottom})`)
      .toBeGreaterThanOrEqual(ACTIVITY_ROWS)

    // (2) Ruler end labels, at both sizes.
    await openView(page, 'timeline')
    await expect(page.getByTestId('timeline-standard-track')).toBeVisible()
    await resetTimelineZoom(page)
    for (const [w, h] of [[800, 500], [1280, 800]] as const) {
      await resizeMainWindow(app, w, h)
      await page.waitForTimeout(600)
      const r = await rulerEnds(page)
      expect(r.count, `${w}x${h}: ruler labels`).toBeGreaterThan(1)
      expect(r.first.left, `${w}x${h}: first label left ${r.first.left} vs pane left ${r.pane.left}`).toBeGreaterThanOrEqual(r.pane.left - 0.5)
      expect(r.first.right, `${w}x${h}: first label right ${r.first.right} vs pane right ${r.pane.right}`).toBeLessThanOrEqual(r.pane.right + 0.5)
      expect(r.last.right, `${w}x${h}: last label right ${r.last.right} vs pane right ${r.pane.right}`).toBeLessThanOrEqual(r.pane.right + 0.5)
      expect(r.last.left, `${w}x${h}: last label left ${r.last.left} vs pane left ${r.pane.left}`).toBeGreaterThanOrEqual(r.pane.left - 0.5)
    }

    // (3) Targets, with the body scrolling under its fixed header.
    await resizeMainWindow(app, 800, 500)
    await openView(page, 'targets')
    await expect(page.getByTestId('targets-search')).toBeVisible()
    await page.waitForTimeout(800)
    const edges = await page.evaluate(() => {
      const header = document.querySelector('[data-testid="targets-scope-header"] > div') as HTMLElement
      const tabs = document.querySelector('[data-testid="targets-scope-header"] [role="tablist"]') as HTMLElement
      const card = (document.querySelector('[data-testid="targets-search"]') as HTMLElement).closest('.rounded-lg') as HTMLElement
      let scroller: HTMLElement | null = card.parentElement
      while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
      return {
        header: header.getBoundingClientRect().right,
        tabs: tabs.getBoundingClientRect().right,
        card: card.getBoundingClientRect().right,
        overflows: !!scroller && scroller.scrollHeight > scroller.clientHeight
      }
    })
    expect(edges.overflows, 'the targets body must overflow for this check to mean anything').toBe(true)
    expect(Math.abs(edges.header - edges.card), `header right ${edges.header} vs cards right ${edges.card}`).toBeLessThanOrEqual(1)
    expect(Math.abs(edges.tabs - edges.card), `tab underline right ${edges.tabs} vs cards right ${edges.card}`).toBeLessThanOrEqual(1)
  } catch (e) {
    console.log(`[DBG] ${(e as Error).message.split('\n').slice(0, 5).join(' | ')}`)
    throw e
  } finally {
    await app.close()
  }
})
