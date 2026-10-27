import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { launchWithTempHome, openTestProject, openView, resizeMainWindow } from './helpers'
import en from '../src/renderer/src/i18n/en.json'
import zh from '../src/renderer/src/i18n/zh-TW.json'

// Deliberate IPC failures get their own isolated process. Reuse it for the
// entire read-state journey; do not contaminate installed capture acceptance.
test('empty, pending and failed reads remain distinguishable and recoverable at high zoom', async ({}, info) => {
  test.setTimeout(120_000)
  const { app, page } = await launchWithTempHome()
  const win = await app.browserWindow(page)
  try {
    await openTestProject(page, 'read-state-layout')
    const sources = [
      { view: 'bookmarks', channel: 'bookmarks:list', empty: [], key: 'bookmarks.empty', error: 'bookmarks-load-error' },
      { view: 'screenshots', channel: 'events:queryScreenshotPage', empty: { items: [], hasMore: false, nextCursor: null }, key: 'screenshots.empty', error: 'screenshots-load-error' },
      { view: 'http_history', channel: 'events:queryHttpFlowPage', empty: { items: [], flowCount: 0, hasMore: false, nextCursor: null }, key: 'httpHistory.empty', error: 'http-load-error' }
    ] as const
    async function answer(channel: string, value: unknown, fail = false, pending = false) {
      await app.evaluate(({ ipcMain }, a) => {
        ipcMain.removeHandler(a.channel)
        ipcMain.handle(a.channel, () => {
          if (a.fail) throw new Error('Synthetic unavailable database: ' + 'long-path/'.repeat(45))
          if (a.pending) return new Promise(resolve => {
            ;(globalThis as unknown as { layoutRead: () => void }).layoutRead = () => resolve(a.value)
          })
          return a.value
        })
      }, { channel, value, fail, pending })
    }
    const matrix: unknown[] = []
    for (const [locale, strings] of [['en', en], ['zh-TW', zh]] as const) {
      await page.evaluate(l => localStorage.setItem('redlog-locale', l), locale)
      await page.reload()
      for (const source of sources) {
        await answer(source.channel, source.empty, false, true)
        await openView(page, source.view)
        await expect(page.getByRole('status').filter({ hasText: strings['common.loading'] })).toBeVisible()
        await expect(page.getByText(strings[source.key], { exact: false })).toHaveCount(0)
        await app.evaluate(() => (globalThis as unknown as { layoutRead: () => void }).layoutRead())
        await expect(page.getByText(strings[source.key], { exact: false })).toBeVisible()
        for (const [width, height, zoom] of [[1280, 800, 1], [800, 600, 2]]) {
          await resizeMainWindow(app, width, height)
          await win.evaluate((w, z) => w.webContents.setZoomFactor(z), zoom)
          const empty = page.getByText(strings[source.key], { exact: false })
          await empty.scrollIntoViewIfNeeded()
          await expect(empty).toBeInViewport()
          matrix.push({ locale, view: source.view, state: 'empty', width, height, zoom })
        }
        await answer(source.channel, source.empty, true)
        await openView(page, 'dashboard')
        await openView(page, source.view)
        const error = page.getByTestId(source.error)
        await expect(error).toBeVisible()
        await expect(page.getByText(strings[source.key], { exact: false })).toHaveCount(0)
        const retry = error.getByRole('button', { name: strings['common.retry'], exact: true })
        await retry.scrollIntoViewIfNeeded()
        await expect(retry).toBeInViewport()
        expect(await page.getByTestId('view-root').evaluate(el => el.scrollWidth <= el.clientWidth + 2)).toBe(true)
        const capture = await win.evaluate(async w => (await w.capturePage()).toPNG().toString('base64'))
        writeFileSync(info.outputPath(`${locale}-${source.view}-error-800-2.png`), Buffer.from(capture, 'base64'))
        matrix.push({ locale, view: source.view, state: 'error', width: 800, height: 600, zoom: 2 })
        await answer(source.channel, source.empty)
        await retry.click()
        await expect(error).toHaveCount(0)
        await expect(page.getByText(strings[source.key], { exact: false })).toBeVisible()
        // At 200%, the source's recovery/setup action must also be reachable.
        if (source.view === 'bookmarks') {
          await page.getByRole('button', { name: strings['bookmarks.quickCapture'], exact: true }).click()
          await expect(page.getByRole('textbox', { name: strings['bookmarks.fieldTitle'], exact: true })).toBeVisible()
          await page.getByRole('button', { name: strings['bookmarks.cancel'], exact: true }).click()
        }
        await resizeMainWindow(app, 1280, 800)
        await win.evaluate(w => w.webContents.setZoomFactor(1))
      }
      await answer('events:distinctAgentTypes', [], true)
      await page.reload()
      await openView(page, 'http_history')
      await page.locator('button[aria-controls="filter-bar-panel"]').click()
      const error = page.getByTestId('filter-lists-error')
      await expect(error).toBeVisible()
      await resizeMainWindow(app, 800, 600)
      await win.evaluate(w => w.webContents.setZoomFactor(2))
      const retry = error.getByRole('button', { name: strings['filter.listsRetry'], exact: true })
      await retry.scrollIntoViewIfNeeded()
      await expect(retry).toBeInViewport()
      await answer('events:distinctAgentTypes', [])
      await retry.click()
      await expect(error).toHaveCount(0)
      await resizeMainWindow(app, 1280, 800)
      await win.evaluate(w => w.webContents.setZoomFactor(1))
    }
    writeFileSync(info.outputPath('read-states.json'), JSON.stringify(matrix, null, 2))
  } catch (error) {
    console.error('[read-state-layout]', (error as Error).message)
    await page.screenshot({ path: info.outputPath('failure.png') }).catch(() => {})
    throw error
  } finally { await app.close() }
})
