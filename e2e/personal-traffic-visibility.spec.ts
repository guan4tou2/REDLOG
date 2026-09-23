import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, openTestProject, openView } from './helpers'

test.describe.serial('personal traffic visibility', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    const launched = await launchWithTempHome()
    app = launched.app
    page = launched.page
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'e2e-personal-visibility')
    const base = `http://127.0.0.1:${readFileSync(join(launched.tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
    const token = readFileSync(join(launched.tmpHome, '.redlog', 'api-token'), 'utf8').trim()
    for (const target of ['127.0.0.1', '10.10.10.5']) {
      const response = await fetch(`${base}/api/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type: 'marker', target_id: target, data: { title: `traffic-canary ${target}` } })
      })
      expect(response.status).toBe(201)
    }
    await openView(page, 'search')
  })

  test.afterAll(async () => { if (app) await app.close() })

  test('hides personal targets by default and reveals them with one filter control', async () => {
    await page.getByTestId('search-input').fill('traffic-canary')
    await expect(page.getByText('→ 10.10.10.5')).toBeVisible()
    await expect(page.getByText('→ 127.0.0.1')).toHaveCount(0)

    const visibility = page.getByRole('button', { name: 'Non-work hidden' })
    await expect(visibility).toBeVisible()
    await visibility.click()

    await expect(page.getByText('→ 127.0.0.1')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Non-work visible' })).toBeVisible()
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+k`)
    await page.getByRole('dialog').getByRole('textbox').fill('Loot')
    await page.getByRole('option').filter({ hasText: 'Loot' }).click()
    await expect(page.locator('[data-view="loot"]')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Non-work visible' })).toBeVisible()
    await page.getByRole('button', { name: 'Non-work visible' }).click()
    await expect(page.getByRole('button', { name: 'Non-work hidden' })).toBeVisible()
  })
})
