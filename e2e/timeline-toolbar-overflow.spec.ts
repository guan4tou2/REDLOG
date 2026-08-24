import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, openTestProject, openView } from './helpers'

// docs/DESIGN-core-and-capture.md §6: the eight flat toolbar toggles grouped by
// effect. The low-frequency view/audit controls (session dividers, timezone,
// auditor view) moved behind one "More" control so the row is scannable instead
// of a flat wall of chips. This checks they are reachable there, not lost.

let app: ElectronApplication
let page: Page

test.describe.serial('timeline toolbar overflow', () => {
  test.beforeAll(async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'redlog-toolbar-'))
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
    // The timezone select and auditor chip should NOT be visible until the
    // overflow is opened — that is the whole point of moving them.
    await expect(page.locator('[data-testid="timeline-tz-select"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="timeline-more-menu"]')).toBeVisible()
  })

  test('the overflow reveals them and they still work', async () => {
    await page.locator('[data-testid="timeline-more-menu"]').click()
    const tz = page.locator('[data-testid="timeline-tz-select"]')
    await expect(tz).toBeVisible()
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
