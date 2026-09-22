import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, makeTempHome, openTestProject } from './helpers'

let app: ElectronApplication
let page: Page
let apiBase: string
let apiToken: string

test.describe.serial('active target context', () => {
  test.beforeAll(async () => {
    const tmpHome = makeTempHome('redlog-active-target-')
    app = await electron.launch({ args: [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'active-target-a')

    apiBase = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
    apiToken = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()
  })

  test.afterAll(async () => { await app?.close() })

  test('persists per project and applies only as a fallback', async () => {
    const input = page.getByTestId('active-target-input')
    await input.fill('10.10.11.24')
    await input.press('Enter')
    await expect(input).toHaveValue('10.10.11.24')

    const initialEvidence = await page.evaluate(async () => {
      const bridge = (window as unknown as { redlog: RedLogAPI }).redlog
      const marker = await bridge.marker.create({ title: 'active target marker' })
      const system = await bridge.events.query({ agentType: 'system', limit: 20, tier: 'all' })
      const changed = system.find((event) => event.data.subtype === 'active_target_changed')
      return { markerTarget: marker?.targetId, changeTarget: changed?.data.active_target }
    })
    const post = async (data: Record<string, unknown>, targetId?: string): Promise<RedLogEvent> => {
      const response = await fetch(`${apiBase}/api/events/seed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiToken}` },
        body: JSON.stringify({ agent_type: 'shell', data, target_id: targetId })
      })
      return await response.json() as RedLogEvent
    }
    const fallback = await post({ subtype: 'command_start', command: 'id' })
    const observed = await post({ subtype: 'command_start', command: 'curl http://10.10.11.99/' })
    const projectResult = await page.evaluate(async () => {
      const bridge = (window as unknown as { redlog: RedLogAPI }).redlog
      const projectA = await bridge.project.active()
      const projectB = await bridge.project.create('active-target-b')
      const inB = await bridge.targetContext.get()
      await bridge.project.open(projectA!.id)
      const restoredA = await bridge.targetContext.get()
      return { projectB: projectB.id, inB, restoredA }
    })

    expect(initialEvidence.markerTarget).toBe('10.10.11.24')
    expect(initialEvidence.changeTarget).toBe('10.10.11.24')
    expect(fallback.targetId).toBe('10.10.11.24')
    expect(observed.targetId).toBe('10.10.11.99')
    expect(projectResult.inB).toBeNull()
    expect(projectResult.restoredA).toBe('10.10.11.24')

    await page.reload()
    await expect(page.getByTestId('active-target-input')).toHaveValue('10.10.11.24')
    await page.getByRole('button', { name: 'Clear current target' }).click()
    await expect(page.getByTestId('active-target-input')).toHaveValue('')
    const clearedMarkerTarget = await page.evaluate(async () => {
      const event = await (window as unknown as { redlog: RedLogAPI }).redlog.marker.create({ title: 'cleared target marker' })
      return event?.targetId
    })
    expect(clearedMarkerTarget).toBeNull()

    await post({ subtype: 'command_start', command: 'ssh 10.10.11.99' }, '10.10.11.99')
    await page.click('[data-view-btn="targets"]')
    const targetRow = page.getByText('10.10.11.99', { exact: true }).locator('..')
    await targetRow.getByRole('button', { name: 'Work on this' }).click()
    await expect(page.getByTestId('active-target-input')).toHaveValue('10.10.11.99')
  })
})
