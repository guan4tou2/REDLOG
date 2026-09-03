import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, openTestProject, openView } from './helpers'

// Design turn 8b, end to end. Two things here can only be caught by the real
// bundle: the temporal-dead-zone crash that a memo referencing a const declared
// below it produces under esbuild (vitest transforms the source and never sees
// it — this file has caught that twice), and the claim that the effective
// marker is derived from data alone, which is only true if it survives a
// reload with no persisted UI state.

let app: ElectronApplication
let page: Page
let tmpHome: string

// The preload surface this spec drives. Declared locally and cast at each use,
// the way the other specs do it — e2e is not part of the renderer tsconfig, so
// `window.redlog` has no ambient type here.
interface AmendBridge {
  events: {
    search: (q: string, limit?: number) => Promise<Array<{ id: string; data: Record<string, unknown> }>>
    getCount: () => Promise<number>
  }
  chain: { verify: (o?: { full?: boolean }) => Promise<{ ok: boolean }> }
  marker: { create: (d: Record<string, unknown>) => Promise<{ id: string } | null> }
  recording: { toggle: () => Promise<boolean> }
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

const selectMarker = async (titleText: string): Promise<void> => {
  await page.click(`[data-timeline-event][title*="${titleText}"]`)
  await page.waitForSelector('[data-testid="marker-amend"]', { timeout: 10_000 })
}

test.describe.serial('amending a marker', () => {
  test.beforeAll(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'redlog-amend-'))
    app = await electron.launch({
      args: [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' }
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'amend')
    await page.waitForTimeout(1500)
    await post('shell', { subtype: 'command_end', command: 'id', exit_code: 0 })
    await post('marker', { title: 'original title', severity: 'info', notes: 'first pass', atTimestamp: Date.now() - 10 * 60_000 })
    await page.waitForTimeout(1500)
    await app.evaluate(async ({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1500, 1000) })
    await page.evaluate(() => localStorage.setItem('redlog-timeline-zoom', '0.25'))
    await page.reload()
    await page.waitForTimeout(2500)
    await openView(page, 'timeline')
    await page.waitForTimeout(1500)
  })

  test.afterAll(async () => { if (app) await app.close() })

  test('a correction replaces what the marker says, and counts itself', async () => {
    await selectMarker('original title')
    await page.click('[data-testid="marker-amend"]')
    await page.fill('[data-testid="marker-amend-title"]', 'amended title')
    await page.press('[data-testid="marker-amend-title"]', 'Enter')
    await page.waitForTimeout(1200)

    await expect(page.locator('[data-testid="marker-amend-count"]').first()).toContainText('1')
    expect(await page.locator('[data-timeline-event][title*="amended title"]').count()).toBeGreaterThan(0)
    expect(await page.locator('[data-testid="marker-history-row"]').count()).toBe(1)
  })

  test('the original row was never touched', async () => {
    // The whole safety argument in one assertion: the chain still verifies, the
    // marker's own stored title is what it always was, and the correction is an
    // extra row rather than an overwrite.
    const stored = await page.evaluate(async () => {
      const rows = await (window as unknown as { redlog: AmendBridge }).redlog.events.search('original title', 50)
      return rows.map((r) => ({ id: r.id, subtype: (r.data as Record<string, unknown>).subtype, title: (r.data as Record<string, unknown>).title }))
    })
    const original = stored.find((r) => !r.subtype)
    expect(original?.title).toBe('original title')

    const verdict = await page.evaluate(() => (window as unknown as { redlog: AmendBridge }).redlog.chain.verify({ full: true }))
    expect(verdict.ok).toBe(true)
  })

  test('survives a reload — the effective marker is derived, not remembered', async () => {
    await page.reload()
    await page.waitForTimeout(2500)
    await openView(page, 'timeline')
    await page.waitForTimeout(1500)
    await selectMarker('amended title')
    await expect(page.locator('[data-testid="marker-amend-count"]').first()).toContainText('1')
  })

  test('a second correction raises the severity and the dot follows it', async () => {
    await page.click('[data-testid="marker-amend"]')
    await page.click('[data-testid="marker-amend-severity-critical"]')
    await page.press('[data-testid="marker-amend-notes"]', 'Meta+Enter')
    await page.waitForTimeout(1200)

    await expect(page.locator('[data-testid="marker-amend-count"]').first()).toContainText('2')
    const filled = await page.evaluate(() => {
      const el = document.querySelector('[data-timeline-event][title*="amended title"]')?.firstElementChild
      return el ? getComputedStyle(el as HTMLElement).backgroundColor !== 'rgba(0, 0, 0, 0)' : null
    })
    expect(filled, 'critical draws as an outline').toBe(false)
  })

  test('searching the old title still finds the finding, reading as it does now', async () => {
    await openView(page, 'search')
    await page.fill('[data-testid="search-input"]', 'original title')
    await page.waitForTimeout(1200)
    const rows = page.locator('[data-testid="marker-amend-count"]')
    expect(await rows.count()).toBeGreaterThan(0)
    expect(await page.locator('text=amended title').count()).toBeGreaterThan(0)
  })

  test('an unpaged original resolves instead of claiming the chain is broken', async () => {
    // Page the marker out of reach: the panel loads 200 rows newest-first, and
    // a correction is always newer than what it corrects, so this is the
    // ordinary case rather than an exotic one.
    for (let i = 0; i < 210; i++) await post('shell', { subtype: 'command_end', command: `filler ${i}`, exit_code: 0 })
    await page.waitForTimeout(3000)
    await page.reload()
    await page.waitForTimeout(3000)
    await openView(page, 'timeline')
    await page.waitForTimeout(2000)

    const html = await page.content()
    expect(html, 'a paging gap must never render as a broken chain').not.toContain('border-red-500/50')
  })

  test('a marker written while recording is paused still appears, with its drop point', async () => {
    const before = await page.evaluate(() => (window as unknown as { redlog: AmendBridge }).redlog.events.getCount())
    // The bridge exposes a toggle, not pause/resume — flip it and flip it back.
    await page.evaluate(async () => {
      const r = (window as unknown as { redlog: AmendBridge }).redlog
      await r.recording.toggle()
      await r.marker.create({
        title: 'written while paused', notes: '', severity: 'info', category: 'custom',
        atTimestamp: Date.now() - 5 * 60_000
      })
    })
    await page.waitForTimeout(1500)
    // In the chain, and on the track without a reload — the fanout is not
    // dropped just because capture is paused (§10).
    expect(await page.evaluate(() => (window as unknown as { redlog: AmendBridge }).redlog.events.getCount())).toBeGreaterThan(before)
    expect(await page.locator('[data-timeline-event][title*="written while paused"]').count()).toBeGreaterThan(0)
    await page.evaluate(() => (window as unknown as { redlog: AmendBridge }).redlog.recording.toggle())
  })
})
