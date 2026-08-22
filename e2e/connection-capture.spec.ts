import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, openTestProject, openView, openSettingsPage } from './helpers'

// docs/DESIGN-core-and-capture.md §2.1, verified in a running app.
//
// The connection monitor shells out to ss/netstat, which an e2e cannot drive
// deterministically — that path is covered by the parser fixtures in
// test/connection-table.test.ts. What this checks is the half an operator sees:
// a connection event lands on the timeline reading as a connection, and the
// capture is something they can turn on and see turned on. The seed door
// stands in for the poller so the render and the toggle are exercised for real.

let app: ElectronApplication
let page: Page

test.describe.serial('connection-level capture', () => {
  test.beforeAll(async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'redlog-conn-'))
    app = await electron.launch({ args: [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'connection-capture')
    await page.waitForTimeout(1500)
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
    const post = (data: Record<string, unknown>): Promise<Response> =>
      fetch(`${base}/api/events/seed`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type: 'scanner', data }) })

    // A reverse shell: opened, then closed 90s later carrying its duration.
    await post({ subtype: 'connection', proto: 'tcp', remote_addr: '10.10.11.24',
      remote_port: 4444, local_port: 51001, detectedTarget: '10.10.11.24' })
    await post({ subtype: 'connection_end', proto: 'tcp', remote_addr: '10.10.11.24',
      remote_port: 4444, local_port: 51001, detectedTarget: '10.10.11.24', duration_sec: 90 })
    await page.waitForTimeout(600)
    await openView(page, 'timeline')
    await page.waitForTimeout(800)
  })

  test.afterAll(async () => { await app?.close() })

  // The two events sit in the Scanner lane. At the default zoom the timeline
  // may cluster them into a lane summary rather than two discrete dots, so
  // assert on the rendered text of the scanner lane, not on [data-timeline-event]
  // — the operator reads the summary either way.
  const timelineText = (): Promise<string> =>
    page.evaluate(() => document.querySelector('[data-testid="view-root"]')?.textContent ?? '')

  test('an established connection lands on the timeline as a connection', async () => {
    expect(await timelineText()).toContain('10.10.11.24:4444')
  })

  test('the close carries the duration — a span, not a bare point', async () => {
    expect(await timelineText()).toMatch(/closed.*90s/)
  })

  test('the operator can turn connection capture on and it sticks', async () => {
    await openView(page, 'settings')
    await openSettingsPage(page, 'captureControl')
    // Reach the checkbox by its label text, not by DOM position.
    const toggle = page.locator('label', { hasText: 'Record established connections' }).locator('input[type="checkbox"]')
    await expect(toggle).toHaveCount(1)
    await toggle.check()
    // Settings autosaves on a 350ms debounce; wait for the round-trip to land
    // rather than reading config the instant the box flips.
    await expect.poll(async () => page.evaluate(async () =>
      (await (window as unknown as { redlog: { config: { get: () => Promise<Record<string, unknown>> } } })
        .redlog.config.get() as { connectionMonitor?: { enabled?: boolean } }).connectionMonitor?.enabled),
      { timeout: 5000 }
    ).toBe(true)
  })

  test('turning it on states the SYN-scan blind spot where the switch is', async () => {
    // The limitation must sit next to the control, not only in a doc — a
    // capture that silently misses a class of activity is worse than one that
    // admits its edge.
    await expect(page.getByText(/SYN scan/i)).toBeVisible()
  })
})
