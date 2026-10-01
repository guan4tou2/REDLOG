import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, makeTempHome, openTestProject, openView } from './helpers'

// HTTP History is a flat HTTP log — Burp Proxy > HTTP history — one row per
// flow, newest first, time in the leading column. It only presents the HTTP
// record; grouping traffic under the command that produced it is the Timeline's
// job, so the panel carries no activity/point-span grouping of its own.

let app: ElectronApplication
let page: Page
let base = ''
let token = ''

test.describe.serial('HTTP history is a flat per-request log', () => {
  test.beforeAll(async () => {
    const tmpHome = makeTempHome('redlog-httphist-')
    app = await electron.launch({
      args: [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' }
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await openTestProject(page, 'http-history')
    await page.waitForTimeout(1500)
    base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()

    const post = (data: Record<string, unknown>): Promise<Response> =>
      fetch(`${base}/api/events/seed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type: 'scanner', data })
      })
    // A handful of flows against one host, then one lone request to another —
    // seeded last, so it is the newest row and lands at the top of the log.
    for (let i = 0; i < 8; i++) {
      const flow = `req-${i}`
      await post({ subtype: 'http_request_start', flow_id: flow, method: 'GET',
        url: `http://target.example/admin${i}`, host: 'target.example' })
      await post({ subtype: 'http_response', flow_id: flow, status: i % 5 === 0 ? 200 : 404,
        url: `http://target.example/admin${i}`, host: 'target.example', duration_ms: 12 })
    }
    await post({ subtype: 'http_request_start', flow_id: 'lone', method: 'POST',
      url: 'http://other.example/login', host: 'other.example' })
    await post({ subtype: 'http_response', flow_id: 'lone', status: 302,
      url: 'http://other.example/login', host: 'other.example', duration_ms: 30 })
    await page.waitForTimeout(800)
    await openView(page, 'http_history')
    await page.waitForTimeout(800)
  })

  test.afterAll(async () => { await app?.close() })

  test('renders one flat table, not grouped activity rows', async () => {
    await expect(page.locator('table')).toBeVisible()
    // The removed grouping left no trace: no activity rows, no view toggle.
    await expect(page.locator('[data-testid="http-activity-row"]')).toHaveCount(0)
    await expect(page.locator('[data-http-view]')).toHaveCount(0)
  })

  test('time is the leading column', async () => {
    const firstHeader = page.locator('table thead th').first()
    await expect(firstHeader).toContainText('When')
  })

  test('every request is its own row', async () => {
    // The lone POST was seeded last, so it is the newest row at the top.
    const row = page.locator('tr', { hasText: '/login' }).first()
    await expect(row).toBeVisible()
    await expect(row).toContainText('POST')
    await expect(row).toContainText('302')
  })

  test('a row opens the request/response detail', async () => {
    await page.locator('tr', { hasText: '/login' }).first().click()
    await expect(page.locator('text=Request').first()).toBeVisible()
    await expect(page.locator('text=Response').first()).toBeVisible()
  })
})
