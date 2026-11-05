import { test, expect } from '@playwright/test'
import { launchWithTempHome, openTestProject } from './helpers'

// Spec 069 US5 (shared frame): the title bar, sidebar and status bar are the
// frame every page sits in. Their sizes are pinned here, in CSS px (offset*,
// not getBoundingClientRect — the body renders at zoom 0.9, CLAUDE.md).
//
//   title bar   40  matches the Stitch prototypes (h-10)
//   status bar  28  the prototype's h-7; was 32. Its controls keep WCAG 2.5.8's
//                   24px floor, so 28 is the smallest the bar can be.
//   sidebar    150  deliberately NOT the prototypes' 224/240: the width is the
//                   longest nav label plus the chord column (Sidebar.tsx), and
//                   a wider rail only adds a gutter between each name and its
//                   number.
test('shared frame keeps its sizes and the status bar controls keep a 24px target', async () => {
  test.setTimeout(60_000)
  const { app, page } = await launchWithTempHome()
  try {
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'Frame')
    const m = await page.evaluate(() => {
      const bar = document.querySelector('[data-testid="status-bar"]') as HTMLElement
      const nav = document.querySelector('nav') as HTMLElement
      const title = nav.parentElement!.previousElementSibling as HTMLElement
      return {
        title: title.offsetHeight,
        status: bar.offsetHeight,
        sidebar: nav.offsetWidth,
        smallestControl: Math.min(...[...bar.querySelectorAll('button')].filter((b) => b.offsetWidth > 0).map((b) => b.offsetHeight))
      }
    })
    expect(m.title, 'title bar').toBe(40)
    expect(m.status, 'status bar').toBe(28)
    expect(m.sidebar, 'sidebar').toBe(150)
    expect(m.smallestControl, 'smallest status-bar control').toBeGreaterThanOrEqual(24)
    expect(m.smallestControl, 'and it fits inside the bar').toBeLessThanOrEqual(m.status)
  } finally {
    await app.close()
  }
})
