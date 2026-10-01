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

  // The title bar's active-target input is gone — it sat on the strip that
  // holds the evidence verbs, for a value set a handful of times an
  // engagement, and Settings and the Targets page both already owned it. The
  // capability did not go with it: Targets ▸ "Work on this" sets it, and it
  // is read back through the bridge. So the semantics this spec exists for —
  // persists per project, applies only as a fallback — are driven through
  // the bridge rather than through a control that no longer exists.
  const activeTarget = (): Promise<string | null> =>
    page.evaluate(() => (window as unknown as { redlog: RedLogAPI }).redlog.targetContext.get())
  const setActiveTarget = (t: string): Promise<unknown> =>
    page.evaluate((v) => (window as unknown as { redlog: RedLogAPI }).redlog.targetContext.set(v), t)

  test('persists per project and applies only as a fallback', async () => {
    await setActiveTarget('10.10.11.24')
    await expect.poll(activeTarget).toBe('10.10.11.24')

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
    await expect.poll(activeTarget).toBe('10.10.11.24')
    await setActiveTarget('')
    await expect.poll(activeTarget).toBeNull()
    const clearedMarkerTarget = await page.evaluate(async () => {
      const event = await (window as unknown as { redlog: RedLogAPI }).redlog.marker.create({ title: 'cleared target marker' })
      return event?.targetId
    })
    expect(clearedMarkerTarget).toBeNull()

    await post({ subtype: 'command_start', command: 'ssh 10.10.11.99' }, '10.10.11.99')
    await page.click('[data-view-btn="targets"]')
    const targetRow = page.getByText('10.10.11.99', { exact: true }).locator('..')
    await targetRow.getByRole('button', { name: 'Work on this' }).click()
    // The Targets page is now the control, so this is the case that matters
    // most: the one surface that can still set it, still does.
    await expect.poll(activeTarget).toBe('10.10.11.99')
  })
})
