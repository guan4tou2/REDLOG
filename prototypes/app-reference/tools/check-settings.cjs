const { chromium } = require('playwright')
const { pathToFileURL } = require('node:url')
const path = require('node:path')
;(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(pathToFileURL(path.resolve(__dirname, '../index.html')).href + '#settings-shell')
    const frame = page.frameLocator('iframe[title="設定"]')
    await frame.locator('[data-action="nav"][data-id="hooks"][aria-current="page"]').waitFor()
    const ids = ['browser', 'captureControl', 'scope', 'network', 'loot', 'retention', 'integrity', 'general', 'hud', 'plugins', 'about']
    for (const id of ids) {
      await frame.locator(`[data-action="nav"][data-id="${id}"]`).click()
      await frame.locator(`[data-action="nav"][data-id="${id}"][aria-current="page"]`).waitFor()
    }
    await page.goto(pathToFileURL(path.resolve(__dirname, '../pages/settings-network.html')).href)
    await page.frameLocator('iframe[title="設定"]').locator('[data-action="nav"][data-id="network"][aria-current="page"]').waitFor()
    if (errors.length) throw new Error(errors.join('\n'))
    console.log('12 settings pages and independent settings page navigation passed')
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
