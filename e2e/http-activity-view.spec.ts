import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, openTestProject, openView } from './helpers'

// docs/DESIGN-core-and-capture.md §3, on the surface that was contradicting it.
//
// The HTTP History panel arrived rendering one row per connection, which is
// Burp's shape: right for a tool you drive traffic with, wrong for a record of
// an engagement, where "I ran a directory brute-force" is one action whether it
// made four requests or forty thousand.

let app: ElectronApplication
let page: Page
let base = ''
let token = ''

test.describe.serial('HTTP history lists activities, not connections', () => {
  test.beforeAll(async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'redlog-httpact-'))
    app = await electron.launch({
      args: [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' }
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await openTestProject(page, 'http-activity')
    await page.waitForTimeout(1500)
    base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()

    // One burst against one host — a brute-force's shape — plus one lone
    // request to a different host.
    //
    // Seeded in parallel on purpose. A scanner event's timestamp is its chain
    // wall-clock; `atTimestamp` is a *rendering* override that by design only
    // markers get, because only markers are placed by hand. So the only way to
    // make a burst look like a burst is for it to actually be one — sixty
    // awaited round-trips take longer than the idle gap and would split the
    // run, which is a property of the seeding, not of the code under test.
    const post = (data: Record<string, unknown>): Promise<Response> =>
      fetch(`${base}/api/events/seed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type: 'scanner', data })
      })
    await Promise.all(Array.from({ length: 30 }, (_, i) => {
      const flow = `burst-${i}`
      return post({ subtype: 'http_request_start', flow_id: flow, method: 'GET',
        url: `http://target.example/admin${i}`, host: 'target.example' })
        .then(() => post({ subtype: 'http_response', flow_id: flow, status: i % 5 === 0 ? 200 : 404,
          url: `http://target.example/admin${i}`, host: 'target.example', duration_ms: 12 }))
    }))
    await post({ subtype: 'http_request_start', flow_id: 'lone', method: 'POST',
      url: 'http://other.example/login', host: 'other.example' })
    await post({ subtype: 'http_response', flow_id: 'lone', status: 302,
      url: 'http://other.example/login', host: 'other.example', duration_ms: 30 })
    await page.waitForTimeout(800)
    await openView(page, 'http_history')
    await page.waitForTimeout(800)
  })

  test.afterAll(async () => { await app?.close() })

  test('thirty requests and one request are two rows, not thirty-one', async () => {
    // Scoped to the panel's own hook, not `[aria-expanded]` — that also
    // matches the title bar's export menu, which is how this first read 3.
    const rows = page.locator('[data-testid="http-activity-row"]')
    await expect(rows).toHaveCount(2)
    await expect(rows.filter({ hasText: 'target.example' })).toHaveCount(1)
  })

  test('the run reads as a span and the lone request as a point', async () => {
    // Shape is not the only channel — each row carries the words too (§5.7).
    const rows = page.locator('[data-testid="http-activity-row"]')
    const burst = rows.filter({ hasText: 'target.example' })
    await expect(burst).toHaveAttribute('data-kind', 'span')
    expect(await burst.innerText()).toContain('30')
    await expect(rows.filter({ hasText: 'other.example' })).toHaveAttribute('data-kind', 'point')
  })

  test('the result shape is legible without opening anything', async () => {
    const text = await page.locator('[data-testid="http-activity-row"]', { hasText: 'target.example' }).innerText()
    expect(text, 'the 404 wall should be visible from the closed row').toMatch(/4xx/)
    expect(text).toMatch(/2xx/)
  })

  test('every connection is still reachable one level down', async () => {
    // "Never rendered individually" is about the top level. Losing them would
    // be a different product.
    const row = page.locator('[data-testid="http-activity-row"]', { hasText: 'target.example' })
    await row.click()
    await expect(page.locator('li', { hasText: '/admin7' })).toBeVisible()
  })

  test('the raw per-request view is still one click away', async () => {
    // Reached by a stable hook, not by its label — the e2e app runs in
    // whichever locale the fixture happens to boot with.
    await page.click('[data-http-view="flows"]')
    await expect(page.locator('table')).toBeVisible()
    await expect(page.locator('[data-http-view="flows"]')).toHaveAttribute('aria-pressed', 'true')
  })
})
