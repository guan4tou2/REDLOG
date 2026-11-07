import { test, expect } from '@playwright/test'
import { launchWithTempHome, openTestProject, openSettingsPage, openView } from './helpers'

// Hold automated IP updates so the retry is the observation that restores the card.
test('an IP read can recover with the Pivot list still visible, and a CDP retry reports the new tab', async () => {
  const { app, page } = await launchWithTempHome()
  try {
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        const send = win.webContents.send.bind(win.webContents)
        win.webContents.send = (channel, ...args) => {
          if (!['ip:status', 'pivots:changed'].includes(channel)) send(channel, ...args)
        }
      }
      for (const channel of ['visibility:signals', 'ip:getStatus', 'pivots:getActive', 'cdp:getTab']) ipcMain.removeHandler(channel)
      ipcMain.handle('visibility:signals', () => ({ evidenceSeen: true, loggedEver: true }))
      ipcMain.handle('ip:getStatus', () => { throw new Error('IP unavailable') })
      ipcMain.handle('pivots:getActive', () => [{ via: 'audit-pivot', tool: 'ssh', ts: 1 }])
      ipcMain.handle('cdp:getTab', () => ({ connected: false, timedOut: true }))
    })
    await openTestProject(page, 'network-recovery')
    const ip = page.getByTestId('ip-status-card')
    await expect(ip).toContainText('Could not read the IP status.')
    await expect(page.getByText('audit-pivot', { exact: true })).toBeVisible()
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('ip:getStatus')
      ipcMain.handle('ip:getStatus', () => ({ ipSafety: 'safe', internalIP: '192.0.2.1', lastCheck: 0 }))
    })
    await ip.getByRole('button', { name: 'Check again' }).click()
    await expect(ip).toContainText('192.0.2.1')
    await openView(page, 'settings')
    await openSettingsPage(page, 'browser')
    await page.getByRole('button', { name: 'Test Connection', exact: true }).click()
    const result = page.getByTestId('cdp-connection-result')
    await expect(result).toContainText('timed out')
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('cdp:getTab')
      ipcMain.handle('cdp:getTab', () => ({ connected: true, title: 'Recovered tab', url: 'about:blank' }))
    })
    await page.getByRole('button', { name: 'Retry browser connection', exact: true }).click()
    await expect(result).toContainText('Recovered tab')
  } finally { await app.close() }
})
