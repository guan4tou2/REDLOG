import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, openTestProject, openView, resizeMainWindow } from './helpers'

// #561: the AI reading mode's Session picker with a catalogue too long to scan.
// Thirty conversations are stored through the real HTTP API; the reader must
// land on one of them from a few typed characters and the keyboard alone.

let app: ElectronApplication
let page: Page
let tmpHome: string

test.beforeAll(async () => {
  test.setTimeout(60_000)
  const launched = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP)
  app = launched.app
  page = launched.page
  tmpHome = launched.tmpHome
})
test.afterAll(async () => { if (app) await app.close() })

test('finds one of thirty AI conversations by typing, with the keyboard only', async () => {
  test.setTimeout(180_000)
  try {
    await openTestProject(page, 'session-picker')
    await page.waitForTimeout(1500)
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
    const say = (n: number) => fetch(`${base}/api/events`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ agent_type: 'agent', data: { subtype: 'assistant_message', agent: n % 2 ? 'codex' : 'claude-code', session_id: `conv-${String(n).padStart(2, '0')}`, full: `words from conversation ${String(n).padStart(2, '0')}` } })
    })
    for (let n = 0; n < 30; n++) expect((await say(n)).ok).toBe(true)

    await resizeMainWindow(app, 1500, 1000)
    await openView(page, 'search')
    await page.locator('#reading-tab-ai').click()
    const trigger = page.locator('button[aria-haspopup="listbox"]')
    await trigger.focus()
    await page.keyboard.press('ArrowDown')
    const field = page.locator('input[role="combobox"]')
    await expect(field).toBeFocused()
    await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(31)

    await page.keyboard.type('conv-17')
    await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(1)
    await expect(page.getByRole('listbox')).toContainText('Codex')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('listbox')).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(page.locator('#reading-panel-ai')).toContainText('words from conversation 17')
    await expect(page.locator('#reading-panel-ai')).not.toContainText('words from conversation 16')

    await page.keyboard.press('ArrowDown')
    await page.keyboard.type('no-such-conversation')
    await expect(page.getByText(/No session matches|沒有符合的 Session/)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('listbox')).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(page.locator('#reading-panel-ai')).toContainText('words from conversation 17')
  } catch (e) {
    console.log(`[DBG] ${(e as Error).message.split('\n').slice(0, 5).join(' | ')}`)
    throw e
  }
})
