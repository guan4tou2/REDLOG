import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, makeTempHome, openTestProject, openView } from './helpers'

// Spec 033 (US2): arriving from a target sets the shared filter's target,
// the FilterBar chip every event view honours, instead of a Timeline-only
// focus that matched seven observation fields and dimmed the rest. The lanes
// stay, TargetView stays, and "what happened to 10.10.11.24" is answered by
// the same target_id predicate the Targets page counted.

let app: ElectronApplication
let page: Page

test.describe.serial('target focus on the timeline', () => {
  test.beforeAll(async () => {
    const tmpHome = makeTempHome('redlog-tfocus-')
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

  const arriveFromTarget = async (): Promise<void> => {
    await openView(page, 'targets')
    // Select the target and jump to the timeline via the keyboard path (§7:
    // the documented target → timeline route).
    await page.keyboard.press('ArrowDown')
    // Land on the 10.10.11.24 row deterministically by clicking it.
    await page.getByText('10.10.11.24', { exact: false }).first().click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
    await expect(page.locator('[data-testid="view-root"][data-view="timeline"]')).toBeVisible()
  }
  const chip = (): ReturnType<Page['getByText']> => page.getByText('Target: 10.10.11.24', { exact: true })

  test('arriving from a target sets the shared target chip', async () => {
    await arriveFromTarget()
    await expect(chip()).toBeVisible()
    await expect(page.locator('[data-testid="timeline-target-focus-badge"]')).toHaveCount(0)
  })

  test('the chip clears it', async () => {
    await chip().getByRole('button', { name: 'Clear' }).click()
    await expect(chip()).toHaveCount(0)
  })

  test('navigating away and back keeps the target, visibly', async () => {
    // FR-005: the target is the shared filter's, so it stays set across views
    // until cleared. It is not silent: the chip says so wherever it applies.
    await arriveFromTarget()
    await openView(page, 'dashboard')
    await openView(page, 'timeline')
    await expect(chip()).toBeVisible()
  })
})
