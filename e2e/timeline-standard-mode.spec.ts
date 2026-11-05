import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, makeTempHome, openTestProject, openView } from './helpers'

// Spec 069 US4 / FR-008: the Timeline opens as a standard, single-track
// sequential view; the swim lanes are the "advanced" mode one click away.
// Selection and zoom belong to the Timeline, not to either mode.

let app: ElectronApplication
let page: Page

test.describe.serial('timeline standard / swim-lane modes', () => {
  test.beforeAll(async () => {
    const tmpHome = makeTempHome('redlog-tl-mode-')
    app = await electron.launch({ args: [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'tl-mode')
    await page.waitForTimeout(1200)
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
    const post = (agent_type: string, data: Record<string, unknown>): Promise<Response> =>
      fetch(`${base}/api/events/seed`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type, data }) })
    await post('shell', { subtype: 'command_end', command: 'whoami', exit_code: 0 })
    await post('marker', { title: 'mode-note', severity: 'info' })
    await page.waitForTimeout(600)
    await openView(page, 'timeline')
    await page.getByTestId('timeline-mode-standard').waitFor({ state: 'visible', timeout: 10_000 })
  })
  test.afterAll(async () => { await app?.close() })

  test('opens in standard mode: a sequential list, no swim lanes', async () => {
    await expect(page.getByTestId('timeline-mode-standard')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('timeline-lane-scroll')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /whoami/ }).first()).toBeVisible()
  })

  test('switching to swim lanes keeps the selection and the zoom', async () => {
    await page.getByRole('button', { name: /whoami/ }).first().click()
    await expect(page.getByTestId('timeline-detail-panel')).toBeVisible()
    await page.getByRole('button', { name: /Zoom in/ }).click()
    const zoom = await page.getByRole('button', { name: /Reset zoom/ }).textContent()
    await page.getByTestId('timeline-mode-lanes').click()
    await expect(page.getByTestId('timeline-lane-scroll')).toBeVisible()
    await expect(page.getByTestId('timeline-detail-panel')).toBeVisible()
    await expect(page.getByTestId('timeline-detail-panel')).toContainText('whoami')
    expect(await page.getByRole('button', { name: /Reset zoom/ }).textContent()).toBe(zoom)
  })

  test('the choice is remembered for the project', async () => {
    await expect(page.getByTestId('timeline-mode-lanes')).toHaveAttribute('aria-pressed', 'true')
    await openView(page, 'dashboard')
    await openView(page, 'timeline')
    await expect(page.getByTestId('timeline-mode-lanes')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('timeline-lane-scroll')).toBeVisible()
    await page.getByTestId('timeline-mode-standard').click()
    await expect(page.getByTestId('timeline-lane-scroll')).toHaveCount(0)
  })
})
