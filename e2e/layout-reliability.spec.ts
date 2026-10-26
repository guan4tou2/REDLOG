import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, openTestProject, openView, resizeMainWindow } from './helpers'
import en from '../src/renderer/src/i18n/en.json'
import zh from '../src/renderer/src/i18n/zh-TW.json'

// One isolated process for the complete matrix, not an App launch per size.
// Native sizing + Electron zoom exercises the actual available container width.
const sizes = [[800, 600], [1280, 800], [1600, 1000], [1920, 1080]] as const
const zooms = [1, 1.5, 2]
const host = `${'long-target-'.repeat(12)}example.test`
const projectName = `Layout ${'long-project-name-'.repeat(8)}`

async function noOverflow(page: Page, selector: string): Promise<void> {
  await expect.poll(() => page.locator(selector).evaluate(el => el.scrollWidth <= el.clientWidth + 2 && el.getBoundingClientRect().right <= innerWidth + 2)).toBe(true)
}

test('five workspaces remain usable across native size, zoom and language changes', async ({}, info) => {
  test.setTimeout(240_000)
  const { app, page, tmpHome } = await launchWithTempHome()
  try {
    await page.evaluate(() => {
      localStorage.setItem('redlog-locale', 'en')
      localStorage.setItem('redlog-timeline-detail-layout', 'right')
      localStorage.setItem('redlog-http-detail-w', '460')
      localStorage.setItem('redlog-http-detail-h', '180')
    })
    await page.reload()
    const project = await openTestProject(page, projectName)
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog/api-port'), 'utf8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog/api-token'), 'utf8').trim()
    const seed = async (agent_type: string, data: Record<string, unknown>) => {
      const res = await fetch(`${base}/api/events/seed`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type, target_id: host, data }) })
      expect(res.ok).toBe(true)
    }
    for (let i = 0; i < 80; i++) {
      await seed('scanner', { subtype: 'http_request_start', flow_id: `extra-${i}`, method: 'GET',
        host, url: `https://${host}/other-${i}` })
    }
    await seed('scanner', { subtype: 'http_request_start', flow_id: 'layout-flow', method: 'GET',
      host, url: `https://${host}/layout-flow`, request_headers: { 'x-layout': 'preserve reader' } })
    await seed('scanner', { subtype: 'http_response', flow_id: 'layout-flow', status: 200,
      host, url: `https://${host}/layout-flow`, response_preview: 'layout-body\n'.repeat(150),
      response_headers: { 'content-type': 'text/plain', 'x-reader-state': 'retained' } })
    await page.evaluate(async () => {
      for (let i = 0; i < 35; i++) await window.redlog.bookmarks.create({ title: `Layout mark ${String(i).padStart(2, '0')}`, note: 'saved note' })
    })
    const shots = join(tmpHome, '.redlog', 'projects', project.id, 'screenshots')
    mkdirSync(shots, { recursive: true })
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
    for (let i = 0; i < 8; i++) {
      const filePath = join(shots, `layout-${i}.png`)
      writeFileSync(filePath, png)
      await seed('screenshot', { filePath, filename: `layout-${i}.png`, trigger: 'manual' })
    }
    const win = await app.browserWindow(page)
    const matrix: unknown[] = []
    let locale = 'en'
    async function fit(width: number, height: number, zoom: number) {
      await resizeMainWindow(app, width, height)
      await win.evaluate((w, z) => w.webContents.setZoomFactor(z), zoom)
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThan(0)
      // Wait for layout observers and paint, without a timer or App restart.
      await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    }
    async function matrixFor(name: string, check: () => Promise<void>) {
      for (const [width, height] of sizes) for (const zoom of zooms) {
        await fit(width, height, zoom)
        await check()
        matrix.push({ locale, name, width, height, zoom, result: 'pass' })
        // Every size/zoom has an actual Electron screenshot for inspection.
        const capture = await win.evaluate(async w => (await w.capturePage()).toPNG().toString('base64'))
        writeFileSync(info.outputPath(`${locale}-${name}-${width}-${zoom}.png`), Buffer.from(capture, 'base64'))
      }
    }
    for (const [language, strings] of [['en', en], ['zh-TW', zh]] as const) {
      locale = language
      await page.evaluate(l => localStorage.setItem('redlog-locale', l), language)
      await page.reload()
      await fit(1920, 1080, 1)
      await openView(page, 'http_history')
      const httpSearch = page.getByPlaceholder(strings['httpHistory.filterPlaceholder'])
      await expect(page.locator('tbody tr[role="option"]')).not.toHaveCount(1)
      await httpSearch.fill('layout-flow')
      await expect(page.locator('tbody tr[role="option"]')).toHaveCount(1)
      await expect(page.getByTestId('http-completeness')).toContainText(strings['httpHistory.complete'])
      await page.locator('tr', { hasText: '/layout-flow' }).first().click()
      await expect(page.getByTestId('http-detail-panel')).toBeVisible()
      await page.getByTestId('http-tab-response').click()
      await page.getByTestId('http-detail-panel').locator('pre').first().evaluate(el => { el.scrollTop = 60 })
      await matrixFor('http', async () => {
        await expect(httpSearch).toHaveValue('layout-flow')
        const root = page.getByTestId('http-workspace')
        const width = await root.evaluate(el => el.clientWidth)
        await expect(page.getByTestId('http-workspace-split')).toHaveAttribute('data-layout', width < 960 ? 'bottom' : 'right')
        await expect(page.getByTestId('http-tab-response')).toHaveAttribute('aria-selected', 'true')
        expect(await page.getByTestId('http-detail-panel').locator('pre').first().evaluate(el => el.scrollTop)).toBeCloseTo(60, 0)
        await page.getByTestId('http-detail-layout-toggle').scrollIntoViewIfNeeded()
        await expect(page.getByTestId('http-detail-layout-toggle')).toBeInViewport()
        await noOverflow(page, '[data-testid="http-workspace"]')
        expect(await page.evaluate(() => [localStorage.getItem('redlog-timeline-detail-layout'), localStorage.getItem('redlog-http-detail-w'), localStorage.getItem('redlog-http-detail-h')])).toEqual(['right', '460', '180'])
      })
      await fit(1920, 1080, 1)
      await expect(page.getByTestId('http-workspace-split')).toHaveAttribute('data-layout', 'right')
      expect(await page.getByTestId('http-detail-panel').evaluate(el => el.offsetWidth)).toBe(460)

      // Real filter inputs, not a renderer-only mock of query state.
      await page.locator('button[aria-controls="filter-bar-panel"]').click()
      await page.locator('#filter-bar-panel select').first().selectOption(host)
      await page.locator('#filter-bar-panel select').nth(1).selectOption('scanner')
      await page.getByRole('button', { name: strings['filter.last1h'], exact: true }).click()
      await matrixFor('filters', async () => {
        const bar = page.locator('button[aria-controls="filter-bar-panel"]').locator('..')
        expect(await bar.evaluate(el => el.scrollWidth <= el.clientWidth + 2)).toBe(true)
        await noOverflow(page, '#filter-bar-panel')
        await page.getByTestId('filter-time-before').scrollIntoViewIfNeeded()
        await expect(page.getByTestId('filter-time-before')).toBeInViewport()
        await expect(bar.locator('span[title]', { hasText: host })).toHaveAttribute('title', expect.stringContaining(host))
      })
      await fit(1920, 1080, 1)
      await page.locator('button[aria-controls="filter-bar-panel"]').click()
      await page.getByRole('button', { name: strings['filter.clearAll'], exact: true }).click()

      await openView(page, 'bookmarks')
      const search = page.getByPlaceholder(strings['bookmarks.searchPlaceholder'])
      await search.fill('Layout mark')
      const list = page.getByRole('listbox')
      const row = list.getByRole('option').first()
      await row.click()
      await page.getByRole('button', { name: strings['bookmarks.edit'], exact: true }).click()
      const note = page.getByRole('textbox', { name: strings['bookmarks.fieldNote'], exact: true })
      await note.fill('unsaved layout draft')
      await list.evaluate(el => { el.scrollTop = 80; el.dispatchEvent(new Event('scroll')) })
      await matrixFor('bookmarks', async () => {
        const width = await page.getByTestId('bookmarks-workspace').evaluate(el => el.clientWidth)
        if (width < 720) {
          await expect(page.getByTestId('bookmarks-back')).toBeVisible()
          await page.getByTestId('bookmarks-back').click()
          await expect(search).toHaveValue('Layout mark')
          expect(await list.evaluate(el => el.scrollTop)).toBeCloseTo(80, 0)
          await row.click()
        }
        await expect(note).toHaveValue('unsaved layout draft')
        await page.getByRole('button', { name: strings['bookmarks.update'], exact: true }).scrollIntoViewIfNeeded()
        await expect(page.getByRole('button', { name: strings['bookmarks.update'], exact: true })).toBeInViewport()
        await noOverflow(page, '[data-testid="bookmarks-workspace"]')
      })
      await fit(1920, 1080, 1)
      await page.getByRole('button', { name: strings['bookmarks.cancel'], exact: true }).click()

      await openView(page, 'screenshots')
      await expect(page.getByTestId('screenshot-grid').locator('[role="button"]')).toHaveCount(8)
      await matrixFor('screenshots', async () => {
        const grid = page.getByTestId('screenshot-grid')
        await page.getByTestId('screenshot-reveal').first().scrollIntoViewIfNeeded()
        await expect(page.getByTestId('screenshot-reveal').first()).toBeInViewport()
        await noOverflow(page, '[data-testid="screenshot-grid"]')
        const columns = await grid.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)
        const width = await grid.evaluate(el => el.clientWidth)
        expect(columns).toBe(Math.max(1, Math.floor((width + 8) / 248)))
      })
      await fit(800, 600, 2)
      await page.getByTestId('screenshot-grid').locator('[role="button"]').first().click()
      await expect(page.getByTestId('screenshot-lightbox')).toBeVisible()
      const previewImage = page.getByTestId('screenshot-lightbox').locator('img')
      const previewSource = await previewImage.getAttribute('src')
      await expect.poll(() => previewImage.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      await fit(1920, 1080, 1)
      await expect(previewImage).toHaveAttribute('src', previewSource!)
      await fit(800, 600, 2)
      await expect(previewImage).toHaveAttribute('src', previewSource!)
      await page.getByTestId('screenshot-lightbox').getByRole('button', { name: strings['common.close'], exact: true }).click()
      await expect(page.getByTestId('screenshot-lightbox')).toHaveCount(0)

      await fit(1280, 800, 1)
      await page.getByTitle(strings['app.closeProject'], { exact: true }).click()
      await page.getByTestId('confirm-actions').getByRole('button').last().click()
      await page.getByRole('button', { name: strings['project.delete'], exact: true }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      await matrixFor('confirm', async () => {
        const geometry = await dialog.evaluate(el => {
          const r = el.getBoundingClientRect()
          return { top: r.top, bottom: r.bottom, height: innerHeight, overflow: el.scrollWidth > el.clientWidth + 2 }
        })
        expect(geometry.top).toBeGreaterThanOrEqual(0)
        expect(geometry.bottom).toBeLessThanOrEqual(geometry.height + 1)
        expect(geometry.overflow).toBe(false)
        await expect(page.getByTestId('confirm-actions').getByRole('button').first()).toBeInViewport()
        await expect(page.getByTestId('confirm-actions').getByRole('button').last()).toBeInViewport()
        await page.getByTestId('confirm-content').evaluate(el => { el.scrollTop = 0 })
        await expect(dialog.getByRole('heading')).toBeInViewport()
        await page.keyboard.press('Tab')
        expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true)
      })
      await dialog.getByRole('textbox').fill(projectName)
      await expect(page.getByTestId('confirm-actions').getByRole('button').last()).toBeEnabled()
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await page.evaluate(id => window.redlog.project.open(id), project.id)
    }
    writeFileSync(info.outputPath('matrix.json'), JSON.stringify(matrix, null, 2))
    expect(matrix).toHaveLength(120)
  } catch (error) {
    console.error('[layout-reliability]', (error as Error).message)
    await page.screenshot({ path: info.outputPath('failure.png') }).catch(() => {})
    throw error
  } finally {
    // Bounded teardown keeps the original assertion visible if shutdown fails.
    await app.close().catch(() => app.process().kill())
  }
})
