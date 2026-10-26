import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { openView, openSettingsPage, resizeMainWindow } from './helpers'
import { findShellTarget, runZsh } from '../test/helpers/zsh-pty'

/** Actual source connection before delivering evidence, in the same app. */
export async function checkSourceRecovery(app: ElectronApplication, page: Page, tmpHome: string): Promise<void> {
  expect(await page.evaluate(async () => (await window.redlog.config.get()).overlay.autoShow)).toBe(true)
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .filter(w => w.webContents.getURL().includes('overlay')).some(w => w.isVisible()))).toBe(false)
  await openView(page, 'settings'); await openSettingsPage(page, 'hooks')
  await expect(page.getByTestId('hook-connect-shell-zsh')).toBeVisible()
  expect(existsSync(join(tmpHome, '.zshrc'))).toBe(false)
  await page.getByTestId('hook-connect-shell-zsh').click()
  const command = await page.getByTestId('record-terminal-command').textContent()
  expect(command).toMatch(/redlog-ok-/)
  await expect(page.getByTestId('hook-connect-shell-zsh')).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('#hook-connection-shell-zsh').getByTestId('record-terminal-command')).toHaveText(command!)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByTestId('record-terminal-command')).toHaveText(command!)
  await expect(page.getByTestId('record-terminal-verified')).toHaveCount(0)
  const shell = findShellTarget(); expect(shell).toBeTruthy()
  const recorded = await runZsh(shell!, { rc: readFileSync(join(tmpHome, '.zshrc'), 'utf8'), commands: [command!], timeoutSeconds: 20,
    env: { _REDLOG_DIR: join(tmpHome, '.redlog'), REDLOG_EXTERNAL_SESSION: '', REDLOG_TERMINAL: '' } })
  expect(recorded.ok, recorded.error).toBe(true)
  await expect(page.getByTestId('record-terminal-verified')).toBeVisible()
  const outputCommand = await page.getByTestId('record-terminal-output-command').textContent()
  const output = await runZsh(shell!, { rc: readFileSync(join(tmpHome, '.zshrc'), 'utf8'), commands: [outputCommand!], timeoutSeconds: 20,
    env: { _REDLOG_DIR: join(tmpHome, '.redlog'), REDLOG_EXTERNAL_SESSION: '', REDLOG_TERMINAL: '' } })
  expect(output.ok, output.error).toBe(true)
  await expect(page.getByTestId('record-terminal-output-verified')).toBeVisible()
  await page.evaluate(async () => { await window.redlog.plugins.setEnabled('pack-host-monitors', false) })
  await openSettingsPage(page, 'captureControl')
  await page.getByTestId('pack-repair-hostMonitors').click()
  const toggle = page.getByTestId('pack-switch-hostMonitors')
  await expect(toggle).not.toBeChecked()
  const config = await page.evaluate(() => window.redlog.config.get())
  expect(config.packs?.hostMonitors).toBe(false)
  await resizeMainWindow(app, 800, 600)
  for (const setting of ['hooks', 'browser', 'captureControl']) {
    await openSettingsPage(page, setting)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
  }
}
