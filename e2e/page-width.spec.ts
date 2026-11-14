import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, openTestProject, openView, openSettingsPage, resizeMainWindow } from './helpers'

// UIUX-STANDARD §27: every page fills the main pane and starts at the pane's
// left padding. This is the one assertion that holds the pages to it together:
// the first content element sits at the same left offset on every page, and
// the page body runs out to the pane's right padding.
//
// Geometry: every number below is read from getBoundingClientRect(), which is
// device pixels, and only ever compared with another getBoundingClientRect()
// value (CLAUDE.md "Measuring geometry in e2e"). The padding is read from the
// scroll parent's computed style, which is CSS pixels, and multiplied by the
// body zoom before it is compared. Nothing is compared with offset*.
//
// The window is wider than any old cap (1080px) so a cap would show.
//
// `first` is the element whose left edge is compared across pages, and `body`
// the element whose right edge must reach the padding. Both are resolved to the
// first VISIBLE match (a hidden duplicate, such as the setup view kept mounted
// behind the dashboard, is skipped). What `first` is, per page:
//   - a heading (h1/h2) on every page that has one: dashboard, first run,
//     activity, targets, evidence, settings home. Headings carry no padding of
//     their own, so their box left is the page's content left edge.
//   - the settings sub-page has no heading before its back button, so it uses
//     the row that holds both (`settings-content`'s first child): the container
//     box, not the button's text, which would sit a button's padding further in.
// Every one of them is expected to share the left offset to within 1.5px (one
// rounding step at fractional zoom); the tolerance is not widened for any page.
interface PageSpec { name: string; open: (page: Page) => Promise<void>; first: string; body: string }

const settingsHome = async (p: Page): Promise<void> => {
  await openView(p, 'settings')
  await expect(p.getByTestId('settings-content')).toBeVisible()
  for (let i = 0; i < 3 && (await p.getByTestId('settings-content').getAttribute('data-page')) !== 'home'; i++) await p.getByTestId('settings-back').click()
}

// Fresh project: the setup view. Its heading is an h2 with no test id; the
// body is the heading block's grandparent (PAGE_BODY itself while the setup
// step shows, the full-width title row once it is behind the working page).
const FIRST_RUN: PageSpec = { name: 'first run', open: p => openView(p, 'dashboard'),
  first: '[data-testid="view-root"] h2', body: '[data-testid="view-root"] h2 >> ../..' }

const PAGES: PageSpec[] = [
  { name: 'dashboard', open: p => openView(p, 'dashboard'), first: '[data-testid="dashboard-header"] h1', body: '[data-testid="dashboard-header"]' },
  { name: 'activity', open: p => openView(p, 'search'), first: '[data-testid="activity-title"]', body: '[data-testid="activity-tab-row"]' },
  { name: 'targets', open: p => openView(p, 'targets'), first: '[data-testid="targets-scope-header"] h1', body: '[data-testid="targets-scope-header"] > div' },
  { name: 'evidence', open: p => openView(p, 'screenshots'), first: '[data-testid="evidence-header"] h1', body: '[data-testid="evidence-header"] [role="tablist"]' },
  { name: 'settings home', open: settingsHome, first: '[data-testid="settings-home"] h1', body: '[data-testid="settings-home"]' },
  { name: 'settings sub-page', open: async p => { await openView(p, 'settings'); await openSettingsPage(p, 'general') },
    first: '[data-testid="settings-content"] > :first-child', body: '[data-testid="settings-content"] > :first-child' }
]

// Full-bleed panes have no heading to measure: what must hold is that the
// pane's own root (inside the keep-alive wrapper when there is one) is as wide
// as the stage, `view-root > div.flex-1.min-h-0` in App.tsx, it sits in.
const FULL_BLEED = [['timeline', 'timeline'], ['http', 'http_history'], ['terminal', 'terminal']] as const

/** First visible match, as a bounding box. `..` steps up (CSS has no parent selector). */
async function measure(page: Page, name: string, sel: string): Promise<{ left: number; right: number }> {
  const m = await page.evaluate((s) => {
    const [css, ...ups] = s.split(' >> ')
    const visible = Array.from(document.querySelectorAll(css)).filter(e => e.getClientRects().length > 0)
    let el: Element | null = visible[0] ?? null
    for (const _ of ups.join('').split('/').filter(x => x === '..')) el = el?.parentElement ?? null
    if (!el) return { count: visible.length, left: 0, right: 0 }
    const r = el.getBoundingClientRect()
    return { count: visible.length, left: r.left, right: r.right }
  }, sel)
  expect(m.count, `${name}: selector ${sel} matched ${m.count} visible elements, expected at least 1`).toBeGreaterThanOrEqual(1)
  return m
}

async function checkPage(page: Page, spec: PageSpec, lefts: Record<string, number>): Promise<void> {
  await spec.open(page)
  await expect(page.locator(spec.first.split(' >> ')[0]).first(), `${spec.name}: first selector ${spec.first}`).toBeVisible()
  const root = await measure(page, spec.name, '[data-testid="view-root"]')
  const first = await measure(page, spec.name, spec.first)
  const body = await measure(page, spec.name, spec.body)
  const zoom = await page.evaluate(() => Number(getComputedStyle(document.body).zoom) || 1)
  const pad = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pad'))) * zoom
  lefts[spec.name] = first.left - root.left
  // A page that overflows scrolls inside the pane, and its scrollbar takes its
  // width from the content: the dashboard measured 23.4px from the pane edge
  // where the padding is 14.4px, the difference being the scrollbar. Both
  // numbers here are CSS pixels of one element (offsetWidth - clientWidth),
  // scaled by the zoom once, so they can be added to the padding.
  const scrollbar = await page.evaluate((s) => {
    const el = Array.from(document.querySelectorAll(s.split(' >> ')[0])).find(e => e.getClientRects().length > 0) as HTMLElement | undefined
    for (let a = el?.parentElement ?? null; a; a = a.parentElement) {
      if (a.dataset.testid === 'view-root') break
      const gutter = a.offsetWidth - a.clientWidth
      if (gutter > 0 && /(auto|scroll)/.test(getComputedStyle(a).overflowY)) return gutter
      // A fixed header above a scrolling body keeps the body's gutter in an
      // empty box at its end (lib/pageLayout HEADER_GUTTER), one scrollbar wide.
      const kept = Array.from(a.children).find(c => (c as HTMLElement).dataset.scrollGutter !== undefined) as HTMLElement | undefined
      if (kept && kept.offsetWidth > 0) return kept.offsetWidth
    }
    return 0
  }, spec.body) * zoom
  // The body reaches the right padding: nothing narrower than the pane minus its padding.
  const gap = root.right - body.right
  expect(gap, `${spec.name}: body (${spec.body}) stops ${gap}px short of the pane edge (padding ${pad}px, scrollbar ${scrollbar}px)`).toBeLessThanOrEqual(pad + scrollbar + 1.5)
}

test('every page starts at one left edge and fills the pane to its right padding', async () => {
  test.setTimeout(180_000)
  const { app, page, tmpHome } = await launchWithTempHome()
  try {
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await page.reload()
    await openTestProject(page, 'page-width')
    await resizeMainWindow(app, 1800, 1000)
    await expect.poll(() => page.evaluate(() => document.querySelector('[data-testid="view-root"]')!.getBoundingClientRect().width)).toBeGreaterThan(1300)

    const lefts: Record<string, number> = {}
    // 1. A fresh project shows the setup view, not the working dashboard.
    await checkPage(page, FIRST_RUN, lefts)

    // 2. Seed events and reopen: first run is latched from the signals read when
    //    the project opens (visual-reference.spec.ts does the same).
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()
    const post = async (agent_type: string, data: Record<string, unknown>): Promise<void> => {
      const r = await fetch(`${base}/api/events/seed`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type, data }) })
      expect(r.ok, `seed ${agent_type}`).toBe(true)
    }
    const at = (minutesAgo: number): number => Date.now() - minutesAgo * 60_000
    await post('shell', { subtype: 'command_start', command: 'nmap -sV 10.0.0.5', source_timestamp: at(10) })
    await post('shell', { subtype: 'command_end', command: 'nmap -sV 10.0.0.5', exit_code: 0, duration_sec: 4, source_timestamp: at(9) })
    await post('scanner', { subtype: 'http_request_start', flow_id: 'w1', method: 'GET', url: 'https://app.example/a', source_timestamp: at(8) })
    await post('scanner', { subtype: 'http_response', flow_id: 'w1', method: 'GET', url: 'https://app.example/a', status: 200, content_length: 4, duration_ms: 9, response_preview: 'ok', source_timestamp: at(8) })
    await post('marker', { title: 'width check', severity: 'important', source_timestamp: at(7) })
    await page.reload()
    await page.waitForSelector('[data-testid="view-root"][data-view="dashboard"]', { timeout: 15_000 })
    await expect(page.getByTestId('first-run-strip'), 'seeded project still shows first run; the seed did not count as capture').toHaveCount(0)

    for (const spec of PAGES) await checkPage(page, spec, lefts)
    const all = Object.values(lefts)
    expect(Math.max(...all) - Math.min(...all), `left edges differ: ${JSON.stringify(lefts)}`).toBeLessThanOrEqual(1.5)

    for (const [name, view] of FULL_BLEED) {
      await openView(page, view)
      const m = await page.evaluate(() => {
        const stage = document.querySelector('[data-testid="view-root"] > div.flex-1.min-h-0') as HTMLElement | null
        if (!stage) return { stage: 0, widest: 0, kids: 0 }
        const kids = Array.from(stage.children).filter(c => c.getClientRects().length > 0)
        const roots = kids.map(c => (c.matches('[data-origin]') ? c.firstElementChild ?? c : c))
        return { stage: stage.getBoundingClientRect().width, widest: Math.max(0, ...roots.map(c => c.getBoundingClientRect().width)), kids: kids.length }
      })
      expect(m.kids, `${name}: no visible child in view-root > div.flex-1.min-h-0 (stage found: ${m.stage > 0})`).toBeGreaterThanOrEqual(1)
      expect(m.widest, `${name}: widest pane root ${m.widest}px of a ${m.stage}px stage`).toBeGreaterThanOrEqual(m.stage - 1.5)
    }
  } finally {
    await app.close()
  }
})
