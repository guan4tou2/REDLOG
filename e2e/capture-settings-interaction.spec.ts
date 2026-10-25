import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { chmodSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, openTestProject, openView, openSettingsPage, resizeMainWindow } from './helpers'

// These cases change ordinary project settings only. Fresh projects plus a
// reset viewport/preferences keep them independent without restarting Electron.
test.describe('settings interaction journey', () => {
  let app: ElectronApplication
  let page: Page
  test.beforeAll(async () => {
    const launched = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP)
    app = launched.app; page = launched.page
  })
  test.beforeEach(async () => {
    const win = await app.browserWindow(page)
    await win.evaluate(w => w.webContents.setZoomFactor(1))
    await resizeMainWindow(app, 1100, 800)
    await page.evaluate(() => localStorage.clear())
  })
  test.afterAll(async () => { if (app) await app.close() })

  test('project settings stay separate from display preferences and long content fits at large scales', async () => {
    test.setTimeout(60_000)
    await openTestProject(page, 'settings-layout')
    await page.evaluate(async () => {
      await window.redlog.httpCapture.stop()
      const cfg = await window.redlog.config.get()
      cfg.operator.name = 'Operator'.repeat(40)
      await window.redlog.config.save(cfg)
      await window.redlog.marker.create({ title: 'Layout acceptance', severity: 'info' })
    })
    for (const locale of ['en', 'zh-TW']) {
      await page.evaluate(value => localStorage.setItem('redlog-locale', value), locale)
      await page.reload()
      await openView(page, 'settings')
      await openSettingsPage(page, 'general')
      await expect(page.getByLabel('ID', { exact: true })).toHaveCount(0)
      await openSettingsPage(page, 'scope')
      await expect(page.getByLabel('ID', { exact: true })).toHaveCount(2)
      await resizeMainWindow(app, 1600, 900)
      for (const setting of ['scope', 'browser', 'captureControl', 'plugins']) {
        await openSettingsPage(page, setting)
        await expect.poll(() => page.getByTestId('settings-content').evaluate(el =>
          el.parentElement!.getBoundingClientRect().right - el.getBoundingClientRect().right
        )).toBeLessThanOrEqual(2)
      }
      await resizeMainWindow(app, 800, 600)
      const win = await app.browserWindow(page)
      for (const zoom of [1, 1.5, 2]) {
        await win.evaluate((w, z) => w.webContents.setZoomFactor(z), zoom)
        await openSettingsPage(page, 'general')
        await page.getByRole('button', { name: locale === 'en' ? 'Largest' : '最大', exact: true }).click()
        await expect(page.getByLabel('ID', { exact: true })).toHaveCount(0)
        console.log('layout bounds', locale, zoom, await page.evaluate(() => ({
          viewport: document.documentElement.clientWidth,
          content: document.documentElement.scrollWidth,
          outside: [...document.querySelectorAll('button,input,select,textarea')].map(el => {
            const r = el.getBoundingClientRect()
            return { text: el.textContent?.trim().slice(0, 30), left: r.left, right: r.right }
          }).filter(r => r.left < -1 || r.right > document.documentElement.clientWidth + 1),
          // What actually widens the page: any element past the edge that no
          // ancestor clips. The list above includes clipped controls, and on
          // Linux the page was 1px wide with none of them responsible.
          widening: [...document.querySelectorAll('body *')].filter(el => {
            // Against the real, fractional viewport: clientWidth and
            // innerWidth both round, and at zoom 1.5 the layout is 533.33 wide.
            if (el.getBoundingClientRect().right <= document.documentElement.getBoundingClientRect().width + 0.01) return false
            for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
              if (getComputedStyle(n).overflowX !== 'visible') return false
            }
            return true
          }).slice(-5).map(el => ({ tag: el.tagName, cls: String(el.className).slice(0, 60), testid: el.getAttribute('data-testid'), text: el.textContent?.trim().slice(0, 30), right: el.getBoundingClientRect().right }))
        })))
        // One pixel of slack, as the controls check above has. On Linux at zoom 2
        // and the largest scale, scrollWidth read 401 against 400 while no
        // unclipped element ended past the root's own fractional width: a
        // rounding in scrollWidth, with nothing actually pushed off screen.
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
        await openView(page, 'dashboard')
        const name = page.getByText('Operator'.repeat(40), { exact: true })
        await expect(name).toBeAttached()
        expect(await name.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
        await openView(page, 'settings')
        await openSettingsPage(page, 'scope')
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)  // same rounding as above
        const pane = page.getByTestId('settings-content')
        await pane.evaluate(el => { el.scrollTop = el.scrollHeight })
        await expect.poll(() => pane.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
        await openSettingsPage(page, 'plugins')
        await expect.poll(() => pane.evaluate(el => el.scrollTop)).toBe(0)
      }
      await win.evaluate(w => w.webContents.setZoomFactor(1))
      await openSettingsPage(page, 'general')
      await page.getByRole('button', { name: locale === 'en' ? 'Normal' : '正常', exact: true }).click()
    }
  })

  test('plugin settings use the available width without overflowing compact windows', async () => {
    await openTestProject(page, 'plugin-layout')
    await page.evaluate(() => window.redlog.httpCapture.stop())
    await openView(page, 'settings')
    await openSettingsPage(page, 'plugins')
    for (const [width, height] of [[1600, 900], [800, 600]]) {
      await resizeMainWindow(app, width, height)
      const sample = page.getByTestId('plugin-sample-input')
      await expect(sample).toBeVisible()
      await expect.poll(() => sample.evaluate(element => {
        const pane = element.closest('.overflow-y-auto')!
        const column = pane.parentElement!
        return column.getBoundingClientRect().right - element.getBoundingClientRect().right
      })).toBeLessThanOrEqual(32)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    }
  })

  test('port drafts are validated before autosave in English and Traditional Chinese', async () => {
    await openTestProject(page, 'capture-port-drafts')
    await page.evaluate(() => window.redlog.httpCapture.stop())
    for (const [locale, label, port] of [
      ['en', 'Managed HTTP capture port', '7777'],
      ['zh-TW', 'RedLog 管理的 HTTP 擷取連接埠', '8888']
    ]) {
      await page.evaluate(value => localStorage.setItem('redlog-locale', value), locale)
      await page.reload()
      await openView(page, 'settings')
      await openSettingsPage(page, 'browser')
      await resizeMainWindow(app, 800, 600)
      const field = page.getByLabel(label, { exact: true })
      const before = await page.evaluate(async () => (await window.redlog.config.get()).httpCapture.port)
      await field.fill('6')
      await expect(field).toHaveValue('6')
      // The field is still focused: no partial setting goes through autosave.
      expect(await page.evaluate(async () => (await window.redlog.config.get()).httpCapture.port)).toBe(before)
      await field.press('Tab')
      await expect(field).toHaveAttribute('aria-invalid', 'true')
      await expect(page.getByRole('alert').filter({ hasText: '1024' })).toBeVisible()
      expect(await page.evaluate(async () => (await window.redlog.config.get()).httpCapture.port)).toBe(before)
      await field.fill(port)
      await field.press('Enter')
      await expect(field).not.toHaveAttribute('aria-invalid', 'true')
      await expect.poll(() => page.evaluate(async () => (await window.redlog.config.get()).httpCapture.port)).toBe(Number(port))
      expect(await page.evaluate(async () => (await window.redlog.config.get()).browser.proxy)).toBe(`http://127.0.0.1:${port}`)
      await page.reload()
      await openView(page, 'settings')
      await openSettingsPage(page, 'browser')
      await expect(page.getByLabel(label, { exact: true })).toHaveValue(port)
    }
  })

  test('a successful settings retry clears its stale error after a real write refusal', async () => {
    test.skip(process.platform === 'win32', 'POSIX file-mode refusal; Windows is covered by the settings save result tests')
    let configPath: string | undefined
    let originalMode: number | undefined
    try {
      const project = await openTestProject(page, 'settings-retry-error')
      await page.evaluate(async () => {
        localStorage.setItem('redlog-locale', 'en')
        await window.redlog.httpCapture.stop()
      })
      configPath = join(await page.evaluate(async id => {
        const projects = await window.redlog.project.list()
        return projects.find(p => p.id === id)!.path
      }, project.id), 'config.yaml')
      originalMode = statSync(configPath).mode & 0o777
      const before = readFileSync(configPath)
      await page.reload()
      await openView(page, 'settings')
      await openSettingsPage(page, 'scope')
      chmodSync(configPath, 0o444)
      await page.getByLabel('Name', { exact: true }).nth(1).fill('Recovered operator')
      await expect(page.getByTestId('settings-save-failed')).toBeVisible()
      await expect(page.getByRole('alert')).toBeVisible()
      expect(readFileSync(configPath)).toEqual(before)
      chmodSync(configPath, originalMode)
      await page.getByRole('button', { name: 'Retry', exact: true }).click()
      await expect(page.getByTestId('settings-save-saved')).toBeVisible()
      await expect(page.getByRole('alert')).toHaveCount(0)
      await expect.poll(async () => (await page.evaluate(() => window.redlog.config.get())).operator.name).toBe('Recovered operator')
      await page.reload()
      expect((await page.evaluate(() => window.redlog.config.get())).operator.name).toBe('Recovered operator')
    } finally {
      if (configPath && originalMode !== undefined) chmodSync(configPath, originalMode)
    }
  })

})

// Deliberate isolation: these cases replace IPC or mutate machine integrations.
test('external-source running and failed IPC reads remain distinct in settings', async () => {
  const { app, page } = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP)
  try {
    await openTestProject(page, 'external-source-status')
    await page.evaluate(() => window.redlog.httpCapture.stop())
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await page.reload()
    // Synthetic read responses exercise real IPC and UI, not a live tcpdump.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('hooks:detect')
      ipcMain.handle('hooks:detect', () => [{ id: 'pcap-capture.fixture', name: 'Fixture capture', available: true, disabled: true, description: 'tcpdump' }])
      ipcMain.removeHandler('capture:health')
      ipcMain.handle('capture:health', () => ({ sources: [{ id: 'pcap-capture.fixture', state: 'ready', running: true }] }))
    })
    await openView(page, 'settings')
    await openSettingsPage(page, 'captureControl')
    await expect(page.getByText('Switched off — and still receiving', { exact: true })).toBeVisible()
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('capture:health')
      ipcMain.handle('capture:health', () => { throw new Error('fixture health read rejected') })
    })
    await openSettingsPage(page, 'hud')
    await openSettingsPage(page, 'captureControl')
    const error = page.getByRole('alert').filter({ hasText: 'fixture health read rejected' })
    await expect(error).toBeVisible()
    await expect(page.getByText('Current state unknown', { exact: true })).toBeVisible()
    await expect(page.getByText('Not running', { exact: true })).toHaveCount(0)
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('capture:health')
      ipcMain.handle('capture:health', () => ({ sources: [{ id: 'pcap-capture.fixture', state: 'off', running: false }] }))
    })
    await error.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(page.getByText('Switched off in Plugins', { exact: true })).toBeVisible()
    await expect(error).toHaveCount(0)
  } finally { await app.close() }
})

test('optional AI recovers in its source entry and requires explicit project authorization', async () => {
  const { app, page, tmpHome } = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP)
  try {
    const first = join(tmpHome, 'client-work')
    const second = join(tmpHome, 'second-client-work')
    mkdirSync(first); mkdirSync(second)
    await openTestProject(page, 'source-navigation')
    await page.evaluate(() => window.redlog.httpCapture.stop())
    await page.evaluate(async () => {
      localStorage.setItem('redlog-locale', 'en')
      const result = await window.redlog.plugins.installOfficialAgent('codex')
      if (!result.ok) throw new Error(result.error)
    })
    await app.evaluate((_electron, home) => {
      const fs = process.getBuiltinModule('fs')!
      const path = process.getBuiltinModule('path')!
      fs.writeFileSync(path.join(home, '.redlog', 'plugins', 'state.json'), JSON.stringify({ disabled: ['official-ai-codex'] }))
    }, tmpHome)
    await page.evaluate(async () => {
      await window.redlog.plugins.reload()
    })
    await page.reload()
    await openView(page, 'settings')
    const other = page.getByRole('button', { name: 'Other capture sources', exact: true })
    await expect(other).toBeVisible()
    await other.click()
    const before = await page.evaluate(() => window.redlog.config.get())
    const row = page.getByTestId('agent-source-codex')
    await row.getByTestId('agent-restore-codex').click()
    await expect.poll(async () => (await page.evaluate(() => window.redlog.plugins.list())).find(p => p.id === 'official-ai-codex')?.status).toBe('active')
    await expect(page.locator('[data-settings-page="captureControl"]')).toHaveAttribute('aria-current', 'page')
    expect(await page.evaluate(() => window.redlog.config.get())).toEqual(before)
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    await expect(page.getByText('Codex CLI', { exact: true })).toHaveCount(0)
    await other.click()
    const setPicker = async (path: string) => app.evaluate(({ ipcMain }, next) => {
      ipcMain.removeHandler('hookConfig:pickPath')
      ipcMain.handle('hookConfig:pickPath', () => next)
    }, path)
    await setPicker(first)
    await row.getByTestId('agent-add-path-codex').click()
    const checkbox = row.getByTestId('agent-enabled-codex')
    await expect(checkbox).toBeEnabled()
    await expect(checkbox).not.toBeChecked()
    await checkbox.check()
    await expect.poll(async () => (await page.evaluate(() => window.redlog.config.get())).agentTailer?.sources?.codex?.enabled).toBe(true)
    await setPicker(second)
    await row.getByTestId('agent-add-path-codex').click()
    // The scope moved under a recording source: the row says so, and the one
    // control that resolves it is the same checkbox, relabelled.
    const scopeChanged = row.getByTestId('agent-scope-changed-codex')
    await expect(scopeChanged).toBeVisible()
    await expect(row.getByText('Confirm this range and record')).toBeVisible()
    await expect(checkbox).not.toBeChecked()
    await expect.poll(async () => (await page.evaluate(() => window.redlog.config.get())).agentTailer?.sources?.codex?.enabled).toBe(false)
    expect((await page.evaluate(() => window.redlog.config.get())).agentTailer.sources.codex.workPaths).toEqual([first, second])
  } finally { await app.close() }
})
