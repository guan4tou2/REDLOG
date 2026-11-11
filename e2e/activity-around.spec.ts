import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, openTestProject, openView, resizeMainWindow } from './helpers'

// #560: an operation's expanded row lists what every source recorded just
// before and after it, and names a relation only where a shared key proves one.

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

test('lists neighbouring events from other sources and labels only keyed relations', async () => {
  test.setTimeout(180_000)
  try {
    await openTestProject(page, 'activity-around')
    await page.waitForTimeout(1500)
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
    const post = (agent_type: string, data: Record<string, unknown>) => fetch(`${base}/api/events`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ agent_type, data })
    })
    const gap = () => new Promise(resolve => setTimeout(resolve, 30))
    const shell = { shell: 'bash', terminalId: 'around-term', subtype: 'command_end', exit_code: 0 }
    await post('shell', { ...shell, command: 'around-earlier-command', command_id: 'c-early' }); await gap()
    await post('agent', { subtype: 'assistant_message', agent: 'claude-code', session_id: 'around-conv', full: 'around-ai-neighbour' }); await gap()
    await post('shell', { ...shell, command: 'around-anchor-command', command_id: 'c-anchor' }); await gap()
    await post('marker', { title: 'around-marker-note' }); await gap()
    await post('shell', { ...shell, command: 'around-later-command', command_id: 'c-late' })

    await resizeMainWindow(app, 1500, 1000)
    await openView(page, 'search')
    await page.getByTestId('activity-row').filter({ hasText: 'around-anchor-command' }).click()
    const toggle = page.getByTestId('activity-around-toggle')
    await expect(page.getByTestId('activity-around')).toHaveCount(0)
    await toggle.click()
    const around = page.getByTestId('activity-around')
    const rows = around.getByTestId('activity-around-event')
    await expect(rows.filter({ hasText: 'around-ai-neighbour' })).toHaveAttribute('data-relation', 'time')
    await expect(rows.filter({ hasText: 'around-marker-note' })).toHaveAttribute('data-relation', 'time')
    await expect(rows.filter({ hasText: 'around-earlier-command' })).toHaveAttribute('data-relation', 'session')
    await expect(rows.filter({ hasText: 'around-later-command' })).toHaveAttribute('data-relation', 'session')
    await expect(around).not.toContainText('around-anchor-command')
  } catch (e) {
    console.log(`[DBG] ${(e as Error).message.split('\n').slice(0, 5).join(' | ')}`)
    throw e
  }
})
