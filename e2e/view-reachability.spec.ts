import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, makeTempHome, openTestProject } from './helpers'

// #558: every view has to be reachable by someone who is looking at the screen,
// not by someone who has read the documentation.
//
// The suite already navigated to each view, but `openView()` in helpers falls
// back to the command palette when it cannot find a control — and that fallback
// is exactly what hid the gap: `timeline` and `transcript` had no entrance on
// any screen for months, and every navigation test still passed because the
// helper went around the UI to prove the view worked.
//
// So this spec never touches the palette. It asserts, per view, that a visible
// control exists and that pressing it lands there. A view that can only be
// reached by typing its name is not reachable.

let app: ElectronApplication
let page: Page
let tmpHome: string

test.beforeAll(async () => {
  tmpHome = makeTempHome('redlog-reachability-')
  app = await electron.launch({
    ...(process.env.REDLOG_PACKAGED_APP ? { executablePath: process.env.REDLOG_PACKAGED_APP } : {}),
    args: process.env.REDLOG_PACKAGED_APP ? [] : [MAIN_ENTRY],
    cwd: REPO_ROOT,
    env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
  await openTestProject(page, 'reachability')
})

test.afterAll(async () => { if (app) await app.close() })

const viewRoot = (): ReturnType<Page['locator']> => page.locator('[data-testid="view-root"]')

test('the seven daily workspaces each have a sidebar control', async () => {
  for (const view of ['dashboard', 'search', 'timeline', 'http_history', 'targets', 'screenshots', 'terminal']) {
    const button = page.locator(`nav [data-view-btn="${view}"]`).first()
    await expect(button, `${view} has no sidebar row`).toBeVisible()
    await button.click()
    await expect(viewRoot()).toHaveAttribute('data-view', view)
  }
})

test('the timeline is reachable from the activity workspace, not only the palette', async () => {
  await page.locator('nav [data-view-btn="search"]').first().click()
  await expect(viewRoot()).toHaveAttribute('data-view', 'search')
  const entry = page.getByTestId('workspace-open-timeline')
  await expect(entry, 'the timeline has no in-page entrance').toBeVisible()
  await entry.click()
  await expect(viewRoot()).toHaveAttribute('data-view', 'timeline')
})

test('the timeline is its own sidebar row on ⌘3, and entering it directly offers no way back', async () => {
  await page.locator('nav [data-view-btn="dashboard"]').first().click()
  const row = page.locator('nav [data-view-btn="timeline"]').first()
  await expect(row).toHaveAttribute('title', /Timeline · (⌘|Ctrl\+)3/)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+3' : 'Control+3')
  await expect(viewRoot()).toHaveAttribute('data-view', 'timeline')
  await expect(row).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('timeline-return')).toHaveCount(0)
  // Activity is no longer the timeline's owner: its row is not the current one.
  await expect(page.locator('nav [data-view-btn="search"]').first()).not.toHaveAttribute('aria-current', 'page')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+7' : 'Control+7')
  await expect(viewRoot()).toHaveAttribute('data-view', 'terminal')
})

test('scope, loot and bookmarks are reachable from the tab strip of their workspace', async () => {
  await page.locator('nav [data-view-btn="targets"]').first().click()
  for (const view of ['targets', 'scope']) {
    const tab = page.locator(`[data-view-btn="${view}"][role="tab"]`)
    await expect(tab, `${view} has no tab in the targets workspace`).toBeVisible()
    await tab.click()
    await expect(viewRoot()).toHaveAttribute('data-view', view)
  }

  await page.locator('nav [data-view-btn="screenshots"]').first().click()
  for (const view of ['screenshots', 'loot', 'bookmarks']) {
    const tab = page.locator(`[data-view-btn="${view}"][role="tab"]`)
    await expect(tab, `${view} has no tab in the evidence workspace`).toBeVisible()
    await tab.click()
    await expect(viewRoot()).toHaveAttribute('data-view', view)
  }
})

// Not fixed here: `transcript` renders the same rows as the Activity
// workspace's 輸入／輸出 and AI 對話 tabs, so the answer may be an entrance or
// it may be deleting the view. That decision is #563; until it is made, this
// records the state instead of pretending the view is reachable.
test.fixme('the transcript is reachable from a screen', async () => {
  await page.locator('nav [data-view-btn="search"]').first().click()
  await expect(page.getByTestId('workspace-open-transcript')).toBeVisible()
})
