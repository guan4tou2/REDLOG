import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, openTestProject, openView, resizeMainWindow } from './helpers'

// Visual reference set (spec 069 audit): the main pages, one data set, one
// locale, at three presentations — desktop, narrow, and large text — written
// to test-results/visual/<variant>/ and uploaded by CI as `e2e-visual-<shard>`
// on every run, pass or fail. Nothing here compares pixels; a person does, side
// by side with the Stitch prototypes. What this spec does assert is that each
// page mounted, so a blank capture cannot pass for a screenshot of the page.

const OUT = join(process.cwd(), 'test-results', 'visual')

const PAGES = [
  'dashboard', 'search', 'timeline', 'terminal', 'targets', 'scope',
  'screenshots', 'loot', 'bookmarks', 'http_history', 'settings'
] as const

// Narrow: the layout switches below 760 CSS px of layout width, and the body
// renders at zoom 0.9, so the window has to be well under 760 device px.
const VARIANTS: Array<{ name: string; size: [number, number]; zoom: number }> = [
  { name: 'desktop', size: [1440, 900], zoom: 1 },
  { name: 'narrow', size: [660, 900], zoom: 1 },
  { name: 'large-text', size: [1440, 900], zoom: 1.25 }
]

let app: ElectronApplication
let page: Page
let tmpHome: string

test.beforeAll(async () => {
  test.setTimeout(120_000)
  const launched = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP)
  app = launched.app
  page = launched.page
  tmpHome = launched.tmpHome
  // The operator's locale. openTestProject reloads, which picks it up.
  await page.evaluate(() => localStorage.setItem('redlog-locale', 'zh-TW'))
  await openTestProject(page, 'visual-reference')

  const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
  const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
  const post = async (agent_type: string, data: Record<string, unknown>): Promise<void> => {
    const r = await fetch(`${base}/api/events`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ agent_type, data }) })
    expect(r.ok).toBe(true)
  }
  await post('shell', { subtype: 'command_start', command: 'nmap -sV 10.0.0.5' })
  await post('shell', { subtype: 'command_end', command: 'nmap -sV 10.0.0.5', exit_code: 0, duration_sec: 12 })
  await post('shell', { subtype: 'command_end', command: 'curl -s https://app.example/login', exit_code: 0, duration_sec: 1 })
  await post('scanner', { subtype: 'http_request_start', flow_id: 'v1', method: 'GET', url: 'https://app.example/api/users' })
  await post('scanner', { subtype: 'http_response', flow_id: 'v1', method: 'GET', url: 'https://app.example/api/users', status: 200, content_length: 42, duration_ms: 87, response_preview: '{"users":[{"id":1}]}' })
  await post('agent', { subtype: 'user_message', agent: 'claude-code', session_id: 'visual-session', full: 'enumerate the web app' })
  await post('agent', { subtype: 'tool_call', agent: 'claude-code', session_id: 'visual-session', tool_name: 'Bash', tool_use_id: 'tv1', tool_input: { command: 'id' } })
  await post('agent', { subtype: 'tool_result', agent: 'claude-code', session_id: 'visual-session', tool_use_id: 'tv1', output: 'uid=1000(op)' })
  await post('marker', { title: 'admin panel found', severity: 'important' })
})

test.afterAll(async () => { if (app) await app.close() })

test.describe.serial('visual-reference', () => {
  for (const variant of VARIANTS) {
    test(`captures the main pages: ${variant.name}`, async () => {
      test.setTimeout(180_000)
      const dir = join(OUT, variant.name)
      mkdirSync(dir, { recursive: true })
      await resizeMainWindow(app, variant.size[0], variant.size[1])
      const win = await app.browserWindow(page)
      await win.evaluate((w, z) => w.webContents.setZoomFactor(z), variant.zoom)
      try {
        for (const [i, view] of PAGES.entries()) {
          await openView(page, view)
          await expect(page.locator(`[data-testid="view-root"][data-view="${view}"]`)).toBeVisible()
          // Lazy panes show a quiet loading line first; let them settle.
          await page.waitForTimeout(800)
          await page.screenshot({ path: join(dir, `${String(i + 1).padStart(2, '0')}-${view}.png`) })
        }
      } catch (e) {
        console.log(`[DBG] ${variant.name}: ${(e as Error).message.split('\n').slice(0, 5).join(' | ')}`)
        throw e
      } finally {
        await win.evaluate((w) => w.webContents.setZoomFactor(1))
      }
    })
  }
})
