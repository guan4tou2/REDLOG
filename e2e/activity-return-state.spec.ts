import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, openTestProject, openView } from './helpers'

// #589: leaving the activity list for the timeline and coming back must put the
// operator where they were — query, filters, which row was open and how far
// down the list they had scrolled — not at the top of a fresh list.
test('returning from the timeline keeps the activity list where it was', async () => {
  test.setTimeout(120_000)
  const { app, page, tmpHome } = await launchWithTempHome()
  try {
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'return-state')
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()
    for (let i = 0; i < 80; i++) {
      const r = await fetch(`${base}/api/events/seed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type: 'shell', data: { subtype: 'command_start', command: `echo marker-${String(i).padStart(3, '0')}` } })
      })
      expect(r.ok).toBe(true)
    }

    await openView(page, 'search')
    await page.getByTestId('search-input').fill('marker')
    await expect(page.getByTestId('activity-row').nth(40)).toBeAttached()
    const results = page.getByTestId('search-results')
    await page.getByTestId('activity-row').first().click()
    await expect(page.getByTestId('activity-row').first()).toHaveAttribute('aria-expanded', 'true')
    await results.evaluate((el) => { el.scrollTop = 900 })
    const before = await results.evaluate((el) => el.scrollTop)
    expect(before).toBeGreaterThan(300)

    await page.getByTestId('workspace-open-timeline').click()
    await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'timeline')
    await page.getByRole('button', { name: /^← / }).click()
    await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'search')

    await expect(page.getByTestId('search-input')).toHaveValue('marker')
    await expect(page.getByTestId('activity-row').first()).toHaveAttribute('aria-expanded', 'true')
    const after = await results.evaluate((el) => el.scrollTop)
    expect(Math.abs(after - before), `scrollTop ${before} → ${after}`).toBeLessThan(4)
  } finally {
    await app.close()
  }
})
