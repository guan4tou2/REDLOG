import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, openTestProject, openView } from './helpers'

// docs/DESIGN-core-and-capture.md §6: the 18 lanes banded by capture group.
// The timeline opens as capture-group bands (collapsed), each expandable to its
// lanes, instead of a wall of eighteen. This is the product's most complex
// screen, so this verifies the real render: bands by default, expand reveals
// lanes, and the events are actually drawn (a band that shows no dots would be
// worse than eighteen lanes).

let app: ElectronApplication
let page: Page

test.describe.serial('timeline lane bands', () => {
  test.beforeAll(async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'redlog-bands-'))
    app = await electron.launch({ args: [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'lane-bands')
    await page.waitForTimeout(1200)
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
    const post = (agent_type: string, data: Record<string, unknown>): Promise<Response> =>
      fetch(`${base}/api/events/seed`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type, data }) })
    // one event in each of the four bands
    await post('shell', { subtype: 'command_end', command: 'whoami' })                       // commands
    await post('scanner', { subtype: 'connection', proto: 'tcp', remote_addr: '10.0.0.9', remote_port: 445 }) // traffic
    await post('screenshot', { trigger: 'manual' })                                          // artifacts
    await post('marker', { title: 'note', severity: 'info' })                                // signals
    await page.waitForTimeout(600)
    await openView(page, 'timeline')
    // Wait for the band row to render rather than a fixed sleep — under full-
    // suite load the render can lag past a fixed timeout.
    await page.locator('[data-testid="timeline-band-commands"]').waitFor({ state: 'visible', timeout: 10_000 })
  })
  test.afterAll(async () => { await app?.close() })

  test('opens as capture-group bands, not eighteen lanes', async () => {
    await expect(page.locator('[data-testid="timeline-band-commands"]')).toBeVisible()
    await expect(page.locator('[data-testid="timeline-band-traffic"]')).toBeVisible()
    await expect(page.locator('[data-testid="timeline-band-artifacts"]')).toBeVisible()
    await expect(page.locator('[data-testid="timeline-band-signals"]')).toBeVisible()
    // The band rows collapse many lanes into four; far fewer than 18 rows.
    const bandRows = await page.locator('[data-testid^="timeline-band-"]').count()
    expect(bandRows).toBeLessThanOrEqual(4)
  })

  test('the collapsed bands still draw their events', async () => {
    // A band that hid its dots would defeat the point. Dots render in the track.
    const dots = await page.locator('[data-timeline-event]').count()
    expect(dots, 'no events rendered in the collapsed bands').toBeGreaterThan(0)
  })

  test('clicking a band expands it into its lanes', async () => {
    await page.locator('[data-testid="timeline-band-commands"]').click()
    // The commands band is now gone (expanded); its shell lane label shows.
    await expect(page.locator('[data-testid="timeline-band-commands"]')).toHaveCount(0)
    const text = await page.evaluate(() => document.querySelector('[data-testid="view-root"]')?.textContent ?? '')
    expect(text.toLowerCase()).toContain('shell')
  })
})
