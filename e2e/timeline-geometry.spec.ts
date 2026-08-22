import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, openTestProject, openView } from './helpers'

// Timeline geometry + startup-gate regressions. These drive the real app
// because none of them are reachable from unit tests: the hook-config read
// happens in the main-process startup path, and the other two are renderer
// layout/geometry. All three shipped as bugs before v0.9.4 — P0-1 in
// particular survived several releases precisely because nothing covered it.

const EXCLUDED = '/tmp/redlog-verify-excluded'

let app: ElectronApplication
let page: Page
let stderr = ''
let stdout = ''
let tmpHome = ''

test.describe.serial('timeline geometry + startup gates', () => {
  test.beforeAll(async () => {
    if (!existsSync(MAIN_ENTRY)) throw new Error(`run "npm run build" first (${MAIN_ENTRY})`)
    tmpHome = mkdtempSync(join(tmpdir(), 'redlog-v094-'))
    // P0-1 setup: a VALID hook-config must exist before the app starts, so
    // startProject() actually walks the read path we fixed.
    mkdirSync(join(tmpHome, '.redlog'), { recursive: true })
    writeFileSync(
      join(tmpHome, '.redlog', 'hook-config.json'),
      JSON.stringify({ excludedPaths: [EXCLUDED], watchPaths: [] }, null, 2)
    )

    app = await electron.launch({
      args: [MAIN_ENTRY],
      cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' }
    })
    const proc = app.process()
    proc.stderr?.on('data', (b: Buffer) => { stderr += b.toString() })
    proc.stdout?.on('data', (b: Buffer) => { stdout += b.toString() })

    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'timeline-geometry')
  })

  test.afterAll(async () => { if (app) await app.close() })

  // ---------------------------------------------------------------- P0-1
  test('hook-config.json is read without throwing (v0.9.4 P0-1)', async () => {
    // The fixed catch block logs anything that is not a SyntaxError. Before
    // the fix this path threw `ReferenceError: os is not defined` on every
    // startProject(), so the presence of that line is the regression signal.
    const combined = stderr + stdout
    expect(combined).not.toContain('hook-config.json unreadable')
    expect(combined).not.toContain('os is not defined')
  })

  // ---------------------------------------------------------------- P0-4
  test('retention sweep resolves in the bundled build (v0.9.4 P0-4)', async () => {
    // `require('../core/retention')` was invisible to rollup, so the module
    // never made it into out/main and every packaged build threw
    // MODULE_NOT_FOUND here — keepDays settings silently did nothing. This
    // only reproduces against the bundle, never against the TS sources.
    const combined = stderr + stdout
    expect(combined).not.toContain('[retention] sweep failed')
    expect(combined).not.toContain("Cannot find module '../core/retention'")
  })

  // ---------------------------------------------------------------- setup
  test('seed all 18 lanes + an out-of-range marker', async () => {
    const port = readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
    const base = `http://127.0.0.1:${port}`
    const now = Date.now()

    const rows: Array<[string, Record<string, unknown>]> = [
      ['shell', { subtype: 'command_end', command: 'nmap -sV 10.0.0.5', exit_code: 0, duration_sec: 12 }],
      ['agent', { subtype: 'user_message', full: 'scan the host', agent: 'claude-code' }],
      ['http_navigation', { url: 'http://10.0.0.5/', host: '10.0.0.5' }],
      ['scanner', { subtype: 'http_response', url: 'http://10.0.0.5/api', status: 200 }],
      ['browser', { subtype: 'console_error', message: 'boom' }],
      ['dns', { subtype: 'dns_query', query: 'target.example' }],
      ['pivot', { tool: 'ssh', via: '10.0.0.5', route: '-D 1080' }],
      ['screenshot', { filename: 'a.jpg', sha256: 'x'.repeat(64) }],
      ['clipboard', { sha256: 'y'.repeat(64), length: 12, lines: 1 }],
      ['file_transfer', { direction: 'ingress', tool: 'curl' }],
      ['credential_use', { user_context: 'admin' }],
      ['c2_checkin', { description: 'implant checked in' }],
      ['marker', { title: 'in-range marker', severity: 'info' }],
      ['loot', { matches: [{ type: 'aws_key', confidence: 'high' }] }],
      ['cleanup', { tool: 'history -c', mitre_ttp: 'T1070.003' }],
      ['process', { subtype: 'spawn', command: 'bash' }],
      ['system', { subtype: 'ip_transition', from: 'unknown', to: 'safe' }],
      ['system', { subtype: 'scope_violation', description: 'out of scope' }],
      // P0-3: a marker whose render position is pushed 30 min past every real
      // event. Before the fix the domain came from `timestamp` only, so this
      // dot's toX() landed past TRACK_W and it silently disappeared.
      ['marker', { title: 'far-future marker', severity: 'critical', atTimestamp: now + 30 * 60_000 }]
    ]

    for (const [agent_type, data] of rows) {
      const r = await fetch(`${base}/api/events/seed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type, data })
      })
      expect(r.ok, `POST ${agent_type} failed: ${r.status}`).toBeTruthy()
    }

    // Shrink the window so 18 lanes cannot fit — this is the P0-2 condition.
    await app.evaluate(async ({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1280, 620)
    })
    await openView(page, 'timeline')
    await page.waitForTimeout(1500)
  })

  // ---------------------------------------------------------------- P0-2
  test('lane stack scrolls vertically instead of clipping (v0.9.4 P0-2)', async () => {
    const geom = await page.evaluate(() => {
      const outer = document.querySelector('div.overflow-y-auto.min-h-0') as HTMLElement | null
      if (!outer) return null
      const labels = outer.firstElementChild as HTMLElement
      return {
        scrollHeight: outer.scrollHeight,
        clientHeight: outer.clientHeight,
        laneRows: labels ? labels.children.length - 1 : 0
      }
    })
    expect(geom, 'scroll container not found').not.toBeNull()
    expect(geom!.laneRows, 'expected all 18 lanes populated').toBe(18)
    expect(geom!.scrollHeight, 'lane stack should overflow at this height')
      .toBeGreaterThan(geom!.clientHeight)

    // And it must actually scroll — the bug was that it could not.
    const scrolled = await page.evaluate(() => {
      const outer = document.querySelector('div.overflow-y-auto.min-h-0') as HTMLElement
      outer.scrollTop = 9999
      return outer.scrollTop
    })
    expect(scrolled, 'container did not scroll vertically').toBeGreaterThan(0)
    await page.screenshot({ path: 'e2e/screenshots/timeline-lane-scroll.png' })
  })

  // ---------------------------------------------------------------- P0-3
  test('every dot renders inside the track (v0.9.4 P0-3)', async () => {
    await page.evaluate(() => {
      const outer = document.querySelector('div.overflow-y-auto.min-h-0') as HTMLElement
      outer.scrollTop = 0
    })
    const res = await page.evaluate(() => {
      const scroll = document.querySelector('div.cursor-grab') as HTMLElement | null
      if (!scroll) return null
      const track = scroll.firstElementChild as HTMLElement
      const trackW = track.getBoundingClientRect().width
      const dots = Array.from(document.querySelectorAll('[data-timeline-event]')) as HTMLElement[]
      const xs = dots.map((d) => d.offsetLeft)
      return { trackW, count: dots.length, min: Math.min(...xs), max: Math.max(...xs) }
    })
    expect(res, 'track not found').not.toBeNull()
    expect(res!.count, 'no dots rendered').toBeGreaterThan(0)
    expect(res!.min, 'a dot rendered left of the track').toBeGreaterThanOrEqual(0)
    expect(res!.max, 'a dot rendered past the track width').toBeLessThanOrEqual(res!.trackW)
    // Visual evidence: zoom all the way out and reset both scroll axes so the
    // whole domain — the real events at the left edge and the far-future
    // marker at the right — is on screen at once.
    for (let i = 0; i < 6; i++) await page.click('button:has-text("\u2212")').catch(() => {})
    await page.evaluate(() => {
      const outer = document.querySelector('div.overflow-y-auto.min-h-0') as HTMLElement
      const scroll = document.querySelector('div.cursor-grab') as HTMLElement
      if (outer) outer.scrollTop = 0
      if (scroll) scroll.scrollLeft = 0
    })
    await page.waitForTimeout(400)
    await page.screenshot({ path: 'e2e/screenshots/timeline-marker-domain.png' })
  })
})
