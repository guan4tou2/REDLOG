import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, openTestProject, openView } from './helpers'

// Design turn 8a, end to end. The unit and DB suites prove the decision and the
// writes; what only the real app can show is that a save actually triggers the
// run through the debounce, that the page reflects it, and that a retroactive
// judgement is visibly different from one made at the time — which is the whole
// point of the feature and the one thing a wrong answer would quietly hide.

let app: ElectronApplication
let page: Page
let tmpHome: string

interface ScopeBridge {
  config: {
    get: () => Promise<Record<string, unknown>>
    save: (c: Record<string, unknown>) => Promise<boolean>
  }
  scope: {
    getViolations: () => Promise<Array<{ judged: string; cleared: boolean; target: string }>>
    getLastRecompute: () => Promise<Record<string, unknown> | null>
  }
  chain: { verify: (o?: { full?: boolean }) => Promise<{ ok: boolean }> }
}

const post = async (agent_type: string, data: Record<string, unknown>): Promise<void> => {
  const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
  const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
  await fetch(`${base}/api/events/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ agent_type, data })
  })
}

/** Save a scope and wait past the trailing debounce for the run to land. */
const setScope = async (targets: string[], excludeTargets: string[]): Promise<void> => {
  await page.evaluate(async ({ targets, excludeTargets }) => {
    const r = (window as unknown as { redlog: ScopeBridge }).redlog
    const cfg = await r.config.get()
    await r.config.save({ ...cfg, scope: { ...(cfg.scope as object), targets, excludeTargets, warnOnViolation: true } })
  }, { targets, excludeTargets })
  await page.waitForTimeout(4000)   // 2 s debounce + the run itself
}

test.describe.serial('recomputing scope after the boundary moves', () => {
  test.beforeAll(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'redlog-scope-'))
    app = await electron.launch({
      args: [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' }
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'scope-recompute')
    await page.waitForTimeout(1500)

    // Work done BEFORE any scope existed. That is the situation the feature is
    // about: the operator did not know yet.
    await post('shell', { subtype: 'command_start', detectedTarget: 'evil.example', command: 'curl https://evil.example/a' })
    await post('shell', { subtype: 'command_start', detectedTarget: 'evil.example', command: 'curl https://evil.example/b' })
    await post('shell', { subtype: 'command_start', detectedTarget: 'www.target.com', command: 'curl https://www.target.com/' })
    await post('dns', { subtype: 'dns_query', query_name: 'evil.example.', query_type: 'A' })
    await page.waitForTimeout(1500)
    await app.evaluate(async ({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1500, 1000) })
  })

  test.afterAll(async () => { if (app) await app.close() })

  test('excluding a host after the fact flags what was already recorded', async () => {
    await setScope(['*.target.com'], ['evil.example'])
    await openView(page, 'scope')
    await page.waitForTimeout(1000)

    const banner = page.locator('[data-testid="scope-recomputed-banner"]')
    await expect(banner).toBeVisible()
    // Three numbers: re-judged, newly flagged, withdrawn.
    await expect(banner).toContainText('newly flagged')

    const summary = await page.evaluate(() =>
      (window as unknown as { redlog: ScopeBridge }).redlog.scope.getLastRecompute())
    expect(summary!.newly_flagged).toBe(3)      // two shell rows plus the DNS query
    expect(summary!.cleared).toBe(0)
  })

  test('every new row says it was judged later, and none of them is a live row', async () => {
    const retro = page.locator('[data-testid="scope-judged-retroactive"]')
    expect(await retro.count()).toBeGreaterThan(0)
    expect(await page.locator('[data-testid="scope-judged-live"]').count()).toBe(0)
    await expect(retro.first()).toContainText('judged later')
  })

  test('the original rows were not touched and the chain still verifies', async () => {
    const verdict = await page.evaluate(() =>
      (window as unknown as { redlog: ScopeBridge }).redlog.chain.verify({ full: true }))
    expect(verdict.ok).toBe(true)
  })

  test('widening the scope withdraws them, and keeps the record', async () => {
    await setScope(['*.target.com', 'evil.example'], [])
    await openView(page, 'scope')
    await page.waitForTimeout(1000)

    const summary = await page.evaluate(() =>
      (window as unknown as { redlog: ScopeBridge }).redlog.scope.getLastRecompute())
    expect(summary!.cleared).toBe(3)

    // The violations are still there — withdrawn, not deleted.
    const rows = await page.evaluate(() =>
      (window as unknown as { redlog: ScopeBridge }).redlog.scope.getViolations())
    expect(rows.length).toBe(3)
    expect(rows.every((r) => r.cleared)).toBe(true)
    // And the page leads with what still stands, which is now nothing.
    await expect(page.locator('[data-testid="scope-show-cleared"]')).toHaveCount(0)
  })

  test('the banner is derived, so it survives a reload', async () => {
    await page.reload()
    await page.waitForTimeout(2500)
    await openView(page, 'scope')
    await page.waitForTimeout(1000)
    await expect(page.locator('[data-testid="scope-recomputed-banner"]')).toBeVisible()
  })

  test('a save that does not move the boundary writes nothing', async () => {
    const before = await page.evaluate(() =>
      (window as unknown as { redlog: ScopeBridge }).redlog.scope.getLastRecompute())
    await setScope(['*.target.com', 'evil.example'], [])
    const after = await page.evaluate(() =>
      (window as unknown as { redlog: ScopeBridge }).redlog.scope.getLastRecompute())
    expect(after!.id).toBe(before!.id)
  })
})
