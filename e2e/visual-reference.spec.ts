import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, openView, resizeMainWindow } from './helpers'

// Visual reference set (spec 069 audit): the main pages, one data set, one
// locale, at three presentations — written to test-results/visual/<variant>/
// and uploaded by CI as `e2e-visual-<shard>` on every run, pass or fail.
// Nothing here compares pixels; a person does, side by side with the Stitch
// prototypes. What this spec asserts is that each page mounted, so a blank
// capture cannot pass for a screenshot of the page.
//
// Three things the first version of this set got wrong, kept here so they stay
// fixed:
// - The dashboard showed first-run onboarding. First run is latched from the
//   signals read when the project opens, so the data is seeded first and the
//   window reloaded before anything is captured.
// - "Narrow" was not narrow. The window cannot go below 800px (windows.ts) and
//   the body renders at zoom 0.9, so window width alone never crosses the 760px
//   layout breakpoint. Narrow here is the minimum window at larger text, which
//   is the one way an operator reaches that layout.
// - Large text was cropped: Playwright's page screenshot keeps the viewport it
//   measured before setZoomFactor. The window is captured from the main
//   process instead, which is exactly what is on screen.

const OUT = join(process.cwd(), 'test-results', 'visual')

const PAGES = [
  'dashboard', 'search', 'timeline', 'terminal', 'targets', 'scope',
  'screenshots', 'loot', 'bookmarks', 'http_history', 'settings'
] as const

const VARIANTS: Array<{ name: string; size: [number, number]; zoom: number }> = [
  { name: 'desktop', size: [1440, 900], zoom: 1 },
  { name: 'large-text', size: [1440, 900], zoom: 1.25 },
  { name: 'narrow', size: [800, 900], zoom: 1.25 }
]

let app: ElectronApplication
let page: Page
let tmpHome: string

async function capture(path: string): Promise<void> {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()
      .find((w) => !w.isDestroyed() && !w.webContents.getURL().includes('overlay'))
    if (!main) throw new Error('main window not found (only the overlay was open)')
    return (await main.webContents.capturePage()).toPNG().toString('base64')
  })
  writeFileSync(path, Buffer.from(png, 'base64'))
}

async function setZoom(zoom: number): Promise<void> {
  const win = await app.browserWindow(page)
  await win.evaluate((w, z) => w.webContents.setZoomFactor(z), zoom)
}

test.beforeAll(async () => {
  test.setTimeout(180_000)
  const launched = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP)
  app = launched.app
  page = launched.page
  tmpHome = launched.tmpHome
  await page.evaluate(() => localStorage.setItem('redlog-locale', 'zh-TW'))

  // A picker with something in it, captured before any project is open.
  // project:create also opens what it creates, so close it to get back to the
  // picker.
  const ids = await page.evaluate(async () => {
    const bridge = (window as unknown as { redlog: { project: { create: (n: string) => Promise<{ id: string }>; close: () => Promise<unknown> } } }).redlog
    await bridge.project.create('acme-external-2026')
    await bridge.project.create('internal-assessment')
    const id = (await bridge.project.create('visual-reference')).id
    await bridge.project.close()
    return id
  })
  await page.reload()
  await expect(page.getByTestId('project-picker')).toBeVisible()
  await resizeMainWindow(app, 1440, 900)
  mkdirSync(OUT, { recursive: true })
  await page.waitForTimeout(500)
  await capture(join(OUT, '00-project-picker-desktop.png'))

  await page.evaluate(async (id) => {
    await (window as unknown as { redlog: { project: { open: (i: string) => Promise<unknown> } } }).redlog.project.open(id)
  }, ids)
  await page.reload()
  await page.waitForSelector('[data-testid="view-root"]', { timeout: 15_000 })

  const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
  const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
  // The seed door accepts RedLog's own derived types (loot), which the public
  // route refuses; nothing else differs.
  const post = async (agent_type: string, data: Record<string, unknown>): Promise<void> => {
    const r = await fetch(`${base}/api/events/seed`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ agent_type, data }) })
    expect(r.ok, `${agent_type} ${String(data.subtype ?? '')}`).toBe(true)
  }
  // Spread over the last half hour, so the Timeline has a span to lay out
  // rather than one second holding every row.
  const at = (minutesAgo: number): number => Date.now() - minutesAgo * 60_000
  await post('shell', { subtype: 'command_start', command: 'nmap -sV -p 80,443,8080 10.0.0.5', source_timestamp: at(28) })
  await post('shell', { subtype: 'command_end', command: 'nmap -sV -p 80,443,8080 10.0.0.5', exit_code: 0, duration_sec: 42, source_timestamp: at(27) })
  await post('scanner', { subtype: 'http_request_start', flow_id: 'v1', method: 'GET', url: 'https://app.example/api/users', source_timestamp: at(22) })
  await post('scanner', { subtype: 'http_response', flow_id: 'v1', method: 'GET', url: 'https://app.example/api/users', status: 200, content_length: 42, duration_ms: 87, response_preview: '{"users":[{"id":1}]}', source_timestamp: at(22) })
  await post('scanner', { subtype: 'http_request_start', flow_id: 'v2', method: 'POST', url: 'https://app.example/api/auth/token', source_timestamp: at(18) })
  await post('scanner', { subtype: 'http_response', flow_id: 'v2', method: 'POST', url: 'https://app.example/api/auth/token', status: 401, content_length: 12, duration_ms: 40, response_preview: 'Unauthorized', source_timestamp: at(18) })
  await post('agent', { subtype: 'user_message', agent: 'claude-code', session_id: 'visual-session', full: 'enumerate the web app', source_timestamp: at(15) })
  await post('agent', { subtype: 'tool_call', agent: 'claude-code', session_id: 'visual-session', tool_name: 'Bash', tool_use_id: 'tv1', tool_input: { command: 'gobuster dir -u https://app.example' }, source_timestamp: at(14) })
  await post('agent', { subtype: 'tool_result', agent: 'claude-code', session_id: 'visual-session', tool_use_id: 'tv1', output: '/admin (Status: 302)', source_timestamp: at(13) })
  await post('shell', { subtype: 'command_end', command: 'curl -s -I https://app.example/admin', exit_code: 0, duration_sec: 1, source_timestamp: at(9) })
  await post('loot', { subtype: 'credential_detected', matches: [{ type: 'password', confidence: 'high', preview: 'admin:Winter2026!' }], count: 1, source: 'hydra', source_timestamp: at(6) })
  await post('screenshot', { subtype: 'captured', filename: 'screenshot-admin-panel.png', sha256: 'a159c8361e21f0b7', trigger: 'manual', source_timestamp: at(5) })
  await post('marker', { title: 'admin panel found', severity: 'important', source_timestamp: at(4) })
  await post('shell', { subtype: 'command_end', command: 'smbclient -L //10.0.0.9 -U guest', exit_code: 1, duration_sec: 3, source_timestamp: at(2) })

  // First run is decided from the signals read at project open; reload so the
  // dashboard is the working one, not onboarding.
  await page.reload()
  await page.waitForSelector('[data-testid="view-root"][data-view="dashboard"]', { timeout: 15_000 })
})

test.afterAll(async () => { if (app) await app.close() })

test.describe.serial('visual-reference', () => {
  for (const variant of VARIANTS) {
    test(`captures the main pages: ${variant.name}`, async () => {
      test.setTimeout(180_000)
      const dir = join(OUT, variant.name)
      mkdirSync(dir, { recursive: true })
      await resizeMainWindow(app, variant.size[0], variant.size[1])
      await setZoom(variant.zoom)
      try {
        for (const [i, view] of PAGES.entries()) {
          await openView(page, view)
          await expect(page.locator(`[data-testid="view-root"][data-view="${view}"]`)).toBeVisible()
          if (view === 'dashboard') await expect(page.getByTestId('first-run-strip')).toHaveCount(0)
          // Lazy panes show a quiet loading line first; let them settle.
          await page.waitForTimeout(900)
          await capture(join(dir, `${String(i + 1).padStart(2, '0')}-${view}.png`))
        }
      } catch (e) {
        console.log(`[DBG] ${variant.name}: ${(e as Error).message.split('\n').slice(0, 5).join(' | ')}`)
        throw e
      } finally {
        await setZoom(1)
      }
    })
  }
})
