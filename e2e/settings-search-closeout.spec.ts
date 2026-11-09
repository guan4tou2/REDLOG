import { test, expect } from '@playwright/test'
import { launchWithTempHome, openTestProject, openView, resizeMainWindow } from './helpers'

test('settings search shows a single result list and opens the matched page', async () => {
  const { app, page } = await launchWithTempHome()
  try {
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'settings-search')
    await openView(page, 'settings')
    await resizeMainWindow(app, 900, 700)
    const query = page.getByRole('textbox', { name: 'Search settings…' })
    await query.fill('proxy')
    const results = page.getByTestId('settings-search-results')
    await expect(results).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('settings-search-narrow.png') })
    await expect(page.getByRole('navigation', { name: 'Settings categories' })).toHaveCount(0)
    await results.getByRole('button').first().click()
    await expect(page.getByTestId('settings-back')).toBeVisible()
    await page.getByTestId('settings-back').click()
    await query.fill('')
    await expect(results).toHaveCount(0)
    await expect(page.locator('[data-settings-page="browser"]')).toBeVisible()
  } finally { await app.close() }
})
