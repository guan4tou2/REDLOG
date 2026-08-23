import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, openTestProject, openView } from './helpers'

// docs/DESIGN-core-and-capture.md §3/§7, the reconciled target axis: rather
// than PR #8's dynamic target-lanes (which also deleted TargetView), the
// timeline gains a target FOCUS — the source lanes stay, TargetView stays, and
// arriving from a target scopes the view to that target's activity. This is
// the reconstruction question "what happened to 10.10.11.24" answered without
// rebuilding the lane model of the product's most complex screen.

let app: ElectronApplication
let page: Page

test.describe.serial('target focus on the timeline', () => {
  test.beforeAll(async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'redlog-tfocus-'))
    app = await electron.launch({ args: [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'target-focus')
    await page.waitForTimeout(1500)
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
    const post = (agent_type: string, data: Record<string, unknown>, target_id?: string): Promise<Response> =>
      fetch(`${base}/api/events/seed`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type, data, target_id }) })

    // Activity against two hosts, so focusing one must dim the other.
    await post('scanner', { subtype: 'connection', proto: 'tcp', remote_addr: '10.10.11.24',
      remote_port: 445, detectedTarget: '10.10.11.24' }, '10.10.11.24')
    await post('shell', { command: 'smbclient //10.10.11.24/share', detectedTarget: '10.10.11.24' }, '10.10.11.24')
    await post('scanner', { subtype: 'connection', proto: 'tcp', remote_addr: '10.10.11.99',
      remote_port: 22, detectedTarget: '10.10.11.99' }, '10.10.11.99')
    await page.waitForTimeout(600)
  })

  test.afterAll(async () => { await app?.close() })

  test('arriving from a target scopes the timeline to it', async () => {
    await openView(page, 'targets')
    // Select the first target and jump to the timeline via the keyboard path
    // (§7: the documented target → timeline route).
    await page.keyboard.press('ArrowDown')
    // Land on the 10.10.11.24 row deterministically by clicking it.
    await page.getByText('10.10.11.24', { exact: false }).first().click()
    await page.keyboard.press('Meta+Enter')
    await expect(page.locator('[data-testid="view-root"][data-view="timeline"]')).toBeVisible()
    const badge = page.locator('[data-testid="timeline-target-focus-badge"]')
    await expect(badge).toBeVisible()
    await expect(badge).toContainText('10.10.11.24')
  })

  test('the focus can be cleared', async () => {
    await page.locator('[data-testid="timeline-target-focus-badge"] button').click()
    await expect(page.locator('[data-testid="timeline-target-focus-badge"]')).toHaveCount(0)
  })

  test('navigating away and back does not silently keep the focus', async () => {
    // focusTarget is cleared on any nav — a stale focus that quietly narrows a
    // later visit is the kind of silent state this product must not have.
    await openView(page, 'dashboard')
    await openView(page, 'timeline')
    await expect(page.locator('[data-testid="timeline-target-focus-badge"]')).toHaveCount(0)
  })
})
