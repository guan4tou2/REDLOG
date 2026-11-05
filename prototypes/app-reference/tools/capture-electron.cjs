// Uses a disposable home and empty project. Run after npm run build, outside the Electron sandbox.
const { _electron: electron } = require('playwright')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const repo = path.resolve(__dirname, '../../..')
const dest = path.resolve(__dirname, '../electron-reference')
fs.mkdirSync(dest, { recursive: true })

;(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-reference-'))
  const app = await electron.launch({ args: [path.join(repo, 'out/main/index.js')], cwd: repo, env: { ...process.env, NODE_ENV: 'test', HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'), REDLOG_E2E: '1', REDLOG_E2E_HIDE_HUD: '1' } })
  const page = await app.firstWindow()
  const result = []
  try {
    await page.waitForLoadState('domcontentloaded')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    const save = async name => {
      // Network status may resolve the operator's real public IP even with an
      // isolated home. Mask IPv4 in the DOM before creating shareable files.
      await page.evaluate(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) {
          const n = walker.currentNode
          n.nodeValue = n.nodeValue.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP]')
        }
      })
      await page.screenshot({ path: path.join(dest, `${name}.png`) })
      fs.writeFileSync(path.join(dest, `${name}.html`), (await page.content()).replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP]').split(repo).join('[REPO]').split(os.homedir()).join('[HOME]'))
      result.push(name)
    }
    await save('projects')
    await page.evaluate(async () => { const p = await window.redlog.project.create('Reference'); await window.redlog.project.open(p.id) })
    await page.reload()
    await page.waitForSelector('[data-testid="view-root"][data-view="dashboard"]', { timeout: 15000 })
    for (const id of ['dashboard', 'search', 'http_history', 'targets', 'screenshots', 'terminal', 'settings']) {
      await page.locator(`[data-view-btn="${id}"]`).first().click()
      await page.waitForSelector(`[data-testid="view-root"][data-view="${id}"]`, { timeout: 15000 })
      await page.waitForTimeout(500)
      await save(id)
    }
    const ids = await page.locator('[data-settings-page]').evaluateAll(els => els.map(e => e.getAttribute('data-settings-page')))
    for (const id of ids) {
      await page.locator(`[data-settings-page="${id}"]`).click()
      await page.waitForTimeout(250)
      await save(`settings-${id}`)
    }
  } finally {
    fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({ description: 'Electron, isolated empty project; HTML is a DOM snapshot, not a standalone app', viewport: '1440x900', pages: result }, null, 2) + '\n')
    await app.close()
  }
  console.log(`Captured ${result.length} Electron states`)
})().catch(error => { console.error(error); process.exitCode = 1 })
