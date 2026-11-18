import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, openTestProject, openView, resizeMainWindow } from './helpers'
import { captionState, expectClearOfCaptionControls } from './caption-geometry'

// The OS window buttons (Windows, Linux) are drawn over the top-right of the
// page. Nothing the app draws may sit under them: not the title strip, in
// either layout, not the views shown before a project is open, not a
// full-window surface. Measured in viewport CSS pixels — see caption-geometry.ts.
//
// This runs where the overlay is real. Under CI's Linux + xvfb that depends on
// whether Chromium reports the overlay there; if it does not, the spec says so
// and skips rather than passing without having measured anything. The Windows
// install smoke (packaged-smoke.spec.ts) asserts the same where it is certain.

test.skip(process.platform === 'darwin', 'macOS puts its buttons on the left; this is the Windows/Linux strip')

// Window width, body zoom. 800 is the window's floor; 1.1 at 800 is the narrow layout.
const SIZES: Array<[number, number, number]> = [
  [1400, 900, 0.9],
  [800, 600, 0.9],
  [800, 600, 1.1],
  [1400, 900, 0.8]
]

async function setZoom(page: Page, zoom: number): Promise<void> {
  // What Settings does; the page follows without a reload.
  await page.evaluate((z) => document.body.style.setProperty('--app-zoom', String(z)), zoom)
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
}

async function everySize(app: ElectronApplication, page: Page, label: string): Promise<void> {
  for (const [w, h, zoom] of SIZES) {
    await resizeMainWindow(app, w, h)
    await setZoom(page, zoom)
    await settle(page)
    await expectClearOfCaptionControls(page, `${label} @ ${w}x${h} zoom ${zoom}`)
  }
}

test('nothing the app draws sits under the OS window buttons', async () => {
  test.setTimeout(180_000)
  const { app, page, tmpHome } = await launchWithTempHome()
  try {
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await page.reload()
    await page.waitForSelector('[data-testid="project-picker"]', { timeout: 30_000 })
    const state = await captionState(page)
    test.skip(!state.visible, `navigator.windowControlsOverlay.visible is false on ${process.platform} in this environment (${state.note}), so there is no strip to measure`)

    await everySize(app, page, 'project picker')

    await openTestProject(page, 'caption-geometry')
    await everySize(app, page, 'dashboard (project open)')

    // The Activity reader: a full-window dialog with its own top bar and close.
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()
    const seeded = await fetch(`${base}/api/events/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ agent_type: 'shell', data: { subtype: 'command_end', command: 'caption-geometry-command', command_id: 'caption-1', exit_code: 0 } })
    })
    expect(seeded.ok, 'seed a command to open in the reader').toBe(true)
    await openView(page, 'search')
    await page.getByTestId('search-input').fill('caption-geometry-command')
    await page.getByTestId('activity-row').first().click()
    await page.getByTestId('activity-read').click()
    await expect(page.getByTestId('activity-reader')).toBeVisible()
    await everySize(app, page, 'Activity reader')
    await page.getByTestId('reader-close').click()
    await expect(page.getByTestId('activity-reader')).toHaveCount(0)

    // One dialog from the title strip itself.
    await page.locator('[aria-haspopup="dialog"]').first().click()
    await expect(page.getByTestId('export-dialog')).toBeVisible()
    await everySize(app, page, 'export dialog')
  } catch (e) {
    console.log(`[DBG] ${(e as Error).message.split('\n').slice(0, 5).join(' | ')}`)
    throw e
  } finally {
    await app.close()
  }
})
