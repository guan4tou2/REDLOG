// Capture the prototype itself, not the Electron application.
const { chromium } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const manifest = require(path.join(root, 'page-manifest.json'))
const dir = path.join(root, 'screenshots')
fs.mkdirSync(dir, { recursive: true })

;(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
  const errors = []
  const inventory = []
  for (const viewport of [{ width: 1440, height: 900 }, { width: 900, height: 700 }]) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 })
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(pathToFileURL(path.join(root, 'index.html')).href)
    await page.evaluate(() => document.fonts.ready)
    for (const item of manifest) {
      await page.evaluate(id => { location.hash = id }, item.id)
      await page.waitForFunction(id => document.title.startsWith(id), item.title)
      if (item.id.startsWith('settings-')) await page.frameLocator('iframe[title="設定"]').locator('#content').waitFor()
      await page.screenshot({ path: path.join(dir, `${item.id}-${viewport.width}.png`) })
      if (viewport.width === 1440) {
        const structure = await page.locator('#root').evaluate(el => ({
          headings: [...el.querySelectorAll('h1,h2,h3')].filter(x => x.getClientRects().length).map(x => ({ level: x.tagName, text: x.textContent.trim() })),
          controls: [...el.querySelectorAll('button,input,select,textarea,a')].filter(x => x.getClientRects().length).map(x => ({ type: x.tagName.toLowerCase(), label: x.getAttribute('aria-label') || x.textContent.trim() || x.getAttribute('placeholder') || '', target: x.getAttribute('href') || null }))
        }))
        if (item.id.startsWith('settings-')) {
          structure.embeddedSettings = await page.frameLocator('iframe[title="設定"]').locator('body').evaluate(el => ({
            text: el.querySelector('#content')?.innerText || '',
            controls: [...el.querySelectorAll('button,input,select,textarea')].filter(x => x.getClientRects().length).map(x => ({ type: x.tagName.toLowerCase(), label: x.getAttribute('aria-label') || x.textContent.trim() || x.getAttribute('placeholder') || '' }))
          }))
        }
        inventory.push({ ...item, screenshot: `screenshots/${item.id}-1440.png`, ...structure })
      }
    }
    await page.close()
  }
  await browser.close()
  fs.writeFileSync(path.join(root, 'layout-inventory.json'), JSON.stringify({ description: '可見原型 DOM；不是 Electron 實測資料', pages: inventory }, null, 2) + '\n')
  fs.writeFileSync(path.join(root, 'validation.json'), JSON.stringify({ target: 'standalone HTML prototype', viewports: ['1440x900', '900x700'], pages: manifest.length, pageErrors: errors }, null, 2) + '\n')
  if (errors.length) throw new Error(errors.join('\n'))
  console.log(`Captured ${manifest.length} pages at two viewports`)
})().catch(error => { console.error(error); process.exitCode = 1 })
