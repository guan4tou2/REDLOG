import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, openTestProject } from './helpers'

test.describe.serial('report mode', () => {
  let app: ElectronApplication
  let page: Page
  let base = ''
  let token = ''

  test.beforeAll(async () => {
    const launched = await launchWithTempHome()
    app = launched.app
    page = launched.page
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'e2e-report-mode')
    base = `http://127.0.0.1:${readFileSync(join(launched.tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
    token = readFileSync(join(launched.tmpHome, '.redlog', 'api-token'), 'utf8').trim()
  })

  test.afterAll(async () => { if (app) await app.close() })

  test('pauses writes while search and export planning remain available', async () => {
    await page.getByTestId('report-mode-toggle').click()
    await expect(page.getByTestId('status-bar-recording')).toHaveAttribute('data-mode', 'reporting')
    await expect(page.getByTestId('status-bar-recording')).toContainText('REPORTING')

    const post = await fetch(`${base}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ agent_type: 'shell', data: { subtype: 'command_end', command: 'must-not-land' } })
    })
    expect(post.status).toBe(200)
    expect(await post.json()).toMatchObject({ recording: false })

    const reads = await page.evaluate(async () => {
      const api = window.redlog
      const [matches, plan] = await Promise.all([
        api.events.search('must-not-land'),
        api.data.resolveExportPlan({ format: 'json' })
      ])
      return { matches: matches.length, planOk: plan.ok }
    })
    expect(reads).toEqual({ matches: 0, planOk: true })

    await page.getByTestId('report-mode-toggle').click()
    await expect(page.getByTestId('status-bar-recording')).toHaveAttribute('data-mode', 'recording')

    const audit = await page.evaluate(() => window.redlog.events.search('report_mode_'))
    const subtypes = audit.map((event) => event.data.subtype)
    expect(subtypes).toContain('report_mode_started')
    expect(subtypes).toContain('report_mode_ended')
  })
})
