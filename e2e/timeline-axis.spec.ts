import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchWithTempHome, openTestProject } from './helpers'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Phase C lane-axis: the timeline can group rows by source type (default) or by
// target. This drives the real app because the two crashes we hit building it —
// a dropped import and a `for (const lane of LANES)` that indexed a target-keyed
// map — both passed `npm run build` and the renderer-smoke unit test; only
// launching the app surfaced them. So the regression guard has to launch too.

let app: ElectronApplication
let page: Page
let tmpHome = ''

const shellLane = (): ReturnType<Page['getByText']> => page.getByText('Shell').first()

test.describe.serial('timeline lane axis', () => {
  test.beforeAll(async () => {
    ;({ app, page, tmpHome } = await launchWithTempHome())
    await openTestProject(page, 'axis-e2e')

    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()
    const port = readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()
    const post = (body: unknown): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}/api/events`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    // Two targets + one untargeted, across source types: source shows
    // Shell/Scanner/DNS; target shows two hosts + the untargeted lane.
    for (const e of [
      { agent_type: 'shell', target_id: '10.0.0.5', data: { subtype: 'command_start', command: 'nmap 10.0.0.5' } },
      { agent_type: 'scanner', target_id: '10.0.0.5', data: { subtype: 'http_request', url: 'http://10.0.0.5/' } },
      { agent_type: 'dns', target_id: 'app.example.com', data: { subtype: 'dns_query', query: 'app.example.com' } },
      { agent_type: 'shell', data: { subtype: 'command_start', command: 'whoami' } }
    ]) await post(e)

    // Normalise the persisted axis to source so the suite is deterministic
    // regardless of a prior session's toggle (localStorage survives across runs).
    await page.evaluate(() => localStorage.setItem('redlog-timeline-lane-axis', 'source'))
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+2' : 'Control+2')
    await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'timeline')
    await expect(shellLane()).toBeVisible({ timeout: 10_000 })
  })

  test.afterAll(async () => { await app?.close() })

  // Normalise the axis to source before each test, deterministically and without
  // a reload: the app already sits on the timeline (beforeAll), and the mounted
  // Timeline listens for this event, so dispatching 'source' resets a prior
  // test's toggle without a racy reload/re-navigation.
  test.beforeEach(async () => {
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('redlog-timeline-set-axis', { detail: 'source' }))
    })
    await expect(shellLane()).toBeVisible({ timeout: 10_000 })
  })

  test('source axis renders source lanes, no crash', async () => {
    await expect(page.getByText('timeline crashed')).toHaveCount(0)
    await expect(shellLane()).toBeVisible()
  })

  test('target axis renders target lanes + untargeted, no crash', async () => {
    await page.getByRole('button').filter({ hasText: 'By source' }).first().click({ timeout: 5000 })
    await expect(page.getByText('timeline crashed')).toHaveCount(0)
    await expect(page.getByText('10.0.0.5').first()).toBeVisible()
    await expect(page.getByText('Untargeted').first()).toBeVisible()
  })

  test('toggling to target and back restores source lanes', async () => {
    await page.getByRole('button').filter({ hasText: 'By source' }).first().click({ timeout: 5000 })
    await expect(page.getByText('10.0.0.5').first()).toBeVisible()
    await page.getByRole('button').filter({ hasText: 'By target' }).first().click({ timeout: 5000 })
    await expect(page.getByText('timeline crashed')).toHaveCount(0)
    await expect(shellLane()).toBeVisible()
  })

  test('phase ribbon toggles on without crashing', async () => {
    // The scanner/dns events infer a "recon" phase, so the ribbon has a dashed
    // band to render. Just guard that enabling it doesn't crash the track.
    await page.getByRole('button').filter({ hasText: 'Phases' }).first().click({ timeout: 5000 })
    await expect(page.getByText('timeline crashed')).toHaveCount(0)
    await expect(shellLane()).toBeVisible()
  })

  test('the Targets sidebar entry deep-links into the timeline target axis', async () => {
    // Step 5 (O3): TargetView was removed; "Targets" now opens the timeline with
    // the target axis on. beforeEach already put us on source.
    await page.locator('nav').getByRole('button', { name: /Targets/ }).click()
    // Success = the timeline is now on the target axis (target lanes present).
    await expect(page.getByText('10.0.0.5').first()).toBeVisible()
    await expect(page.getByText('Untargeted').first()).toBeVisible()
    await expect(page.getByText('timeline crashed')).toHaveCount(0)
  })
})
