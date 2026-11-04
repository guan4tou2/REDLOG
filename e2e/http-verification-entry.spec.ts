import { test, expect } from '@playwright/test'
import { launchWithTempHome, openTestProject, openView, openSettingsPage, resizeMainWindow } from './helpers'

test('HTTP settings exposes the real verification flow by keyboard at narrow width', async () => {
  const { app, page } = await launchWithTempHome()
  try {
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await page.reload()
    await openTestProject(page, 'HTTP entry')
    await openView(page, 'settings')
    await openSettingsPage(page, 'browser')
    await resizeMainWindow(app, 900, 700)
    const entry = page.getByRole('button', { name: 'Verify HTTPS capture', exact: true })
    await expect(entry).toBeVisible()
    await entry.focus()
    await page.keyboard.press('Enter')
    await expect(entry).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('#http-verification-panel section')).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('http-verification-entry.png') })
    await entry.click()
    await expect(page.locator('#http-verification-panel')).toHaveCount(0)
  } finally { await app.close() }
})
