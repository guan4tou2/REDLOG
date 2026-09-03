import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, openTestProject } from './helpers'

// docs/UIUX-STANDARD.md §22. The unit tests prove the model; only the real app
// can show that hiding a row leaves it reachable and leaves the chords alone —
// which is the whole reason hiding is acceptable at all.

let app: ElectronApplication
let page: Page
let tmpHome: string

const post = async (agent_type: string, data: Record<string, unknown>, target_id?: string): Promise<void> => {
  const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
  const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
  await fetch(`${base}/api/events/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ agent_type, data, ...(target_id ? { target_id } : {}) })
  })
}

const navButtons = (): Promise<string[]> =>
  page.$$eval('[data-view-btn]', (els) => els.map((e) => e.getAttribute('data-view-btn') ?? ''))

/** Wait for the debounced re-probe to land rather than guessing a timeout. */
const waitForView = async (id: string): Promise<void> => {
  await page.waitForSelector(`[data-view-btn="${id}"]`, { timeout: 15_000 })
}

test.describe.serial('progressive disclosure', () => {
  test.beforeAll(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'redlog-disclose-'))
    app = await electron.launch({
      args: [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' }
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'disclosure')
    await page.waitForTimeout(2000)
    await app.evaluate(async ({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1500, 1000) })
  })

  test.afterAll(async () => { if (app) await app.close() })

  test('a fresh project offers four buttons, not twelve', async () => {
    const buttons = await navButtons()
    expect(buttons.sort()).toEqual(['dashboard', 'settings', 'terminal', 'timeline'])
  })

  test('a hidden view is still reachable by its chord, which still means what it always meant', async () => {
    // This is what makes hiding acceptable rather than lossy. 目標 is hidden
    // right now; ⌘8 opens it anyway.
    await page.keyboard.press('Meta+8')
    await page.waitForTimeout(500)
    const view = await page.getAttribute('[data-testid="view-root"]', 'data-view')
    expect(view).toBe('targets')
    await page.keyboard.press('Meta+2')
    await page.waitForTimeout(500)
    expect(await page.getAttribute('[data-testid="view-root"]', 'data-view')).toBe('timeline')
  })

  test('a command with a target unlocks 目標, wearing its own number', async () => {
    await post('shell', { subtype: 'command_start', command: 'curl https://a.example/' }, 'a.example')
    await waitForView('targets')
    expect(await navButtons()).toContain('targets')
    // 8, because that is where `targets` sits in the fixed order — not because
    // it is the fourth row currently rendered.
    const label = await page.getAttribute('[data-view-btn="targets"]', 'title')
    expect(label).toContain('8')
    // 範圍 waits for a second target.
    expect(await navButtons()).not.toContain('scope')
  })

  test('a second target unlocks 範圍', async () => {
    await post('shell', { subtype: 'command_start', command: 'curl https://b.example/' }, 'b.example')
    await waitForView('scope')
    expect(await navButtons()).toContain('scope')
  })

  test('proxy traffic alone does not unlock the HTTP page; a real flow does', async () => {
    // A chained connection row is a scanner row, but the HTTP page reads the
    // logged tier — unlocking on it would open a permanently empty page.
    await post('scanner', { subtype: 'connection', remoteAddr: '10.0.0.9', host: 'c.example' })
    await page.waitForTimeout(1500)
    expect(await navButtons()).not.toContain('http_history')

    await post('scanner', { subtype: 'http_request_start', host: 'c.example', method: 'GET', url: 'https://c.example/' })
    await waitForView('http_history')
  })

  test('the numbers never shift as rows appear', async () => {
    for (const [view, expected] of [['dashboard', '1'], ['timeline', '2'], ['targets', '8']] as const) {
      const title = await page.getAttribute(`[data-view-btn="${view}"]`, 'title')
      expect(title, `${view}`).toContain(expected)
    }
    await page.keyboard.press('Meta+2')
    await page.waitForTimeout(400)
    expect(await page.getAttribute('[data-testid="view-root"]', 'data-view')).toBe('timeline')
  })

  test('the escape hatch shows every page, and survives a reload', async () => {
    await page.click('[data-view-btn="settings"]')
    await page.waitForTimeout(500)
    await page.click('[data-settings-page="general"]')
    await page.waitForTimeout(500)
    await page.check('[data-testid="show-all-pages"]')
    await page.waitForTimeout(800)
    expect((await navButtons()).length).toBe(12)

    await page.reload()
    await page.waitForTimeout(2500)
    expect((await navButtons()).length).toBe(12)
  })

  test('unticking it returns to the derived set', async () => {
    await page.click('[data-view-btn="settings"]')
    await page.waitForTimeout(500)
    await page.click('[data-settings-page="general"]')
    await page.waitForTimeout(500)
    await page.uncheck('[data-testid="show-all-pages"]')
    await page.waitForTimeout(800)
    const buttons = await navButtons()
    expect(buttons).toContain('targets')      // still unlocked by data
    expect(buttons).not.toContain('loot')     // never had any
  })
})
