import { test, expect } from '@playwright/test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchWithTempHome, openTestProject } from './helpers'

test('title and status controls stay inside their bars at supported desktop widths', async () => {
  const { app, page } = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP)
  try {
    await openTestProject(page, 'engagement-with-a-long-name-for-multiple-concurrent-targets')
    const window = await app.browserWindow(page)
    for (const locale of ['en', 'zh-TW']) {
      await page.evaluate((locale) => localStorage.setItem('redlog-locale', locale), locale)
      await page.reload()
      for (const width of [1400, 1000, 800]) {
        await window.evaluate((window, width) => window.setSize(width, 850), width)
        await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
        const strip = await page.getByTestId('first-run-strip').boundingBox()
        const more = await page.getByTestId('first-run-more-sources').boundingBox()
        expect(strip).not.toBeNull()
        expect(more).not.toBeNull()
        expect(more!.y, `${locale} ${width}px source disclosure overlaps core setup`).toBeGreaterThanOrEqual(strip!.y + strip!.height - 1)
        for (const bar of ['app-titlebar', 'app-statusbar']) {
          await expect(page.getByTestId(bar)).toBeVisible()
          const clipped = await page.getByTestId(bar).evaluate((element) => {
            const bounds = element.getBoundingClientRect()
            return Array.from(element.querySelectorAll('button, input')).filter((control) => {
              const rect = control.getBoundingClientRect()
              return rect.width && rect.height && (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1 || rect.left < bounds.left - 1 || rect.right > bounds.right + 1)
            }).map((el) => el.textContent || el.getAttribute('aria-label'))
          })
          expect(clipped, `${locale} ${width}px ${bar}`).toEqual([])
        }
      }
    }
    await expect(page.locator('.xterm').first()).toBeVisible()
    expect((await page.locator('.xterm').first().boundingBox())!.width).toBeGreaterThan(400)
    await page.getByTestId('active-target-input').fill('lab.test')
    await page.getByTestId('active-target-input').press('Enter')
    await expect(page.getByTestId('active-target-input')).toHaveValue('lab.test')
    await page.getByTestId('status-bar-recording').click()
    await expect(page.getByTestId('status-bar-recording')).toHaveAttribute('data-recording', 'off')
    await page.screenshot({ path: join(tmpdir(), 'redlog-shell-compact.png') })
  } finally { await app.close() }
})
