import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchWithTempHome, openTestProject, openView } from './helpers'

test('a setup draft never reaches the existing terminal input', async () => {
  const { app, page } = await launchWithTempHome()
  try {
    await openTestProject(page, 'setup-draft')
    await openView(page, 'terminal')
    await expect(page.locator('.xterm').first()).toBeVisible()
    await app.evaluate(({ ipcMain }) => {
      ;(globalThis as any).__setupWrites = 0
      ipcMain.on('terminal:write', () => { (globalThis as any).__setupWrites++ })
    })
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('redlog:run-in-terminal', { detail: 'echo setup-draft-only' }))
    })
    await expect(page.getByTestId('setup-command-review')).toContainText('echo setup-draft-only')
    expect(await app.evaluate(() => (globalThis as any).__setupWrites)).toBe(0)
    await page.screenshot({ path: join(tmpdir(), 'redlog-setup-command-review.png') })
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
    await expect(page.getByTestId('setup-command-review')).toHaveCount(0)
  } finally { await app.close() }
})
