import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { MAIN_ENTRY, REPO_ROOT, makeTempHome, openTestProject, openView } from './helpers'

// docs/DESIGN-core-and-capture.md §6: the eight flat toolbar toggles grouped by
// effect. The low-frequency view controls (session dividers, timezone) moved
// behind one "More" control so the row is scannable instead of a flat wall of
// chips. This checks they are reachable there, not lost. The auditor view left
// the menu in spec 033: "Chained only" is a FilterBar chip every view applies.

let app: ElectronApplication
let page: Page

test.describe.serial('timeline toolbar overflow', () => {
  test.beforeAll(async () => {
    const tmpHome = makeTempHome('redlog-toolbar-')
    app = await electron.launch({ args: [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'toolbar-overflow')
    await openView(page, 'timeline')
  })
  test.afterAll(async () => { await app?.close() })

  test('the rare view controls are not in the flat row', async () => {
    // The timezone select should NOT be visible until the overflow is
    // opened — that is the whole point of moving it.
    await expect(page.locator('[data-testid="timeline-tz-select"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="timeline-more-menu"]')).toBeVisible()
  })

  test('the overflow reveals them and they still work', async () => {
    await page.locator('[data-testid="timeline-more-menu"]').click()
    const tz = page.locator('[data-testid="timeline-tz-select"]')
    await expect(tz).toBeVisible()
    // Spec 033 SC-007: the tier is one control, the FilterBar chip, not a
    // second switch in this menu.
    await expect(page.locator('[data-testid="timeline-auditor-view-chip"]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Chained only/ })).toBeVisible()
    // Toggling the timezone through the menu persists to localStorage.
    await tz.selectOption('utc')
    const stored = await page.evaluate(() => localStorage.getItem('redlog-timeline-tz'))
    expect(stored).toContain('utc')
  })

  test('the menu closes on outside click', async () => {
    await page.mouse.click(5, 5)
    await expect(page.locator('[data-testid="timeline-tz-select"]')).toHaveCount(0)
  })
})
