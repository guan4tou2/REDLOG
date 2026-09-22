import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, makeTempHome, openTestProject, openView } from './helpers'

let app: ElectronApplication
let page: Page

test.describe.serial('event causal chain', () => {
  test.beforeAll(async () => {
    const tmpHome = makeTempHome('redlog-causal-e2e-')
    app = await electron.launch({ args: [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'causal-chain')

    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()
    const post = async (data: Record<string, unknown>): Promise<{ id: string }> => {
      const res = await fetch(`${base}/api/events/seed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type: 'marker', data })
      })
      expect(res.status).toBe(201)
      return await res.json() as { id: string }
    }

    const now = Date.now()
    const parent = await post({ subtype: 'created', title: 'causal parent', atTimestamp: now - 3_600_000 })
    for (let i = 0; i < 205; i++) {
      await post({ subtype: 'created', title: `filler ${i}`, atTimestamp: now - 2_000_000 + i * 5_000 })
    }
    await post({ subtype: 'created', title: 'causal effect', atTimestamp: now, _causes: [parent.id] })

    await openView(page, 'timeline')
    await page.waitForTimeout(1800)
  })

  test.afterAll(async () => { if (app) await app.close() })

  test('focus loads a cause outside the initial timeline page', async () => {
    const effect = page.locator('[data-timeline-event][aria-label*="causal effect"]')
    await expect(effect).toBeVisible()
    await effect.click()
    await page.keyboard.press('f')

    const badge = page.getByTestId('timeline-focus-badge')
    await expect(badge).toContainText('2 events')
    await expect(page.locator('[data-timeline-event][aria-label*="causal parent"]')).toHaveCount(1)
    await expect(badge).not.toContainText('unavailable')
  })
})
