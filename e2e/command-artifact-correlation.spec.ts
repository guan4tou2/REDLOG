import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, makeTempHome, openTestProject, openView } from './helpers'

let app: ElectronApplication
let page: Page

test.describe.serial('command artifact correlation', () => {
  test.beforeAll(async () => {
    const tmpHome = makeTempHome('redlog-artifact-correlation-e2e-')
    app = await electron.launch({
      args: [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' }
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'artifact-correlation')

    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()
    const post = async (agentType: string, data: Record<string, unknown>): Promise<{ id: string }> => {
      const response = await fetch(`${base}/api/events/seed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type: agentType, data })
      })
      expect(response.status).toBe(201)
      return await response.json() as { id: string }
    }

    const command = { command: 'nmap -oA loot/scan 10.0.0.8', terminalId: 'e2e-t1', pid: 991, cwd: '/tmp/work' }
    await post('shell', { subtype: 'command_start', ...command })
    await post('file_transfer', { subtype: 'file_created', source: 'file-watcher', path: '/tmp/work/loot/scan.xml' })
    await post('shell', { subtype: 'command_end', ...command })
    await openView(page, 'timeline')
    await page.waitForTimeout(800)
  })

  test.afterAll(async () => { if (app) await app.close() })

  test('labels cwd overlap as a possible relationship rather than causation', async () => {
    const file = page.locator('[data-timeline-event][aria-label*="scan.xml"]')
    await expect(file).toBeVisible()
    await file.click()
    await expect(page.getByText('Possible related commands')).toBeVisible()
    await expect(page.getByText(/does not prove which process wrote the file/)).toBeVisible()
    await expect(page.getByText('Caused by:')).toHaveCount(0)
  })
})
