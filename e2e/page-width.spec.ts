import { test, expect, type Page } from '@playwright/test'
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
interface PageSpec { name: string; open: (page: Page) => Promise<void>; first: string; body: string }

const PAGES: PageSpec[] = [
  { name: 'dashboard', open: p => openView(p, 'dashboard'), first: '[data-testid="dashboard-header"] h1', body: '[data-testid="dashboard-header"]' },
  { name: 'activity', open: p => openView(p, 'search'), first: '[data-testid="activity-title"]', body: '[data-testid="recording-workspace"] [role="tablist"]' },
  { name: 'targets', open: p => openView(p, 'targets'), first: '[data-testid="targets-scope-header"] h1', body: '[data-testid="targets-scope-header"] > div' },
  { name: 'evidence', open: p => openView(p, 'screenshots'), first: '[data-testid="evidence-header"] h1', body: '[data-testid="evidence-header"] [role="tablist"]' },
  { name: 'settings home', open: async p => { await openView(p, 'settings'); await expect(p.getByTestId('settings-content')).toBeVisible(); if ((await p.getByTestId('settings-content').getAttribute('data-page')) !== 'home') await p.getByTestId('settings-back').click() },
    first: '[data-testid="settings-home"] h1', body: '[data-testid="settings-home"]' },
  { name: 'settings sub-page', open: async p => { await openView(p, 'settings'); await openSettingsPage(p, 'general') },
    first: '[data-testid="settings-back"]', body: '[data-testid="settings-content"] > *' }
]

// Full-bleed panes have no heading to measure: what must hold is that the
// pane's own root is as wide as the stage it sits in.
const FULL_BLEED = [['timeline', 'timeline'], ['http', 'http_history'], ['terminal', 'terminal']] as const

test('every page starts at one left edge and fills the pane to its right padding', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launchWithTempHome()
  try {
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await page.reload()
    await openTestProject(page, 'page-width')
    await resizeMainWindow(app, 1800, 1000)
    await expect.poll(() => page.evaluate(() => document.querySelector('[data-testid="view-root"]')!.getBoundingClientRect().width)).toBeGreaterThan(1300)

    const lefts: Record<string, number> = {}
    for (const spec of PAGES) {
      await spec.open(page)
      await expect(page.locator(spec.first).first()).toBeVisible()
      const m = await page.evaluate(({ first, body }) => {
        const root = document.querySelector('[data-testid="view-root"]')!.getBoundingClientRect()
        const f = document.querySelector(first)!.getBoundingClientRect()
        const b = document.querySelector(body)!.getBoundingClientRect()
        const zoom = Number(getComputedStyle(document.body).zoom) || 1
        const pad = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pad')) * zoom
        return { left: f.left - root.left, rightGap: root.right - b.right, pad, rootWidth: root.width }
      }, { first: spec.first, body: spec.body })
      lefts[spec.name] = m.left
      // The body reaches the right padding: nothing narrower than the pane minus its padding.
      expect(m.rightGap, `${spec.name}: body stops ${m.rightGap}px short of the pane edge (padding ${m.pad}px)`).toBeLessThanOrEqual(m.pad + 1.5)
    }
    const all = Object.values(lefts)
    expect(Math.max(...all) - Math.min(...all), `left edges differ: ${JSON.stringify(lefts)}`).toBeLessThanOrEqual(1.5)

    for (const [name, view] of FULL_BLEED) {
      await openView(page, view)
      const m = await page.evaluate(() => {
        const stage = document.querySelector('[data-testid="view-root"] > div.flex-1.min-h-0') as HTMLElement
        const w = stage.getBoundingClientRect().width
        const widest = Math.max(0, ...Array.from(stage.children).filter(c => (c as HTMLElement).offsetParent !== null).map(c => c.getBoundingClientRect().width))
        return { stage: w, widest }
      })
      expect(m.widest, `${name}: widest child ${m.widest}px of a ${m.stage}px stage`).toBeGreaterThanOrEqual(m.stage - 1.5)
    }
  } finally {
    await app.close()
  }
})
