import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, makeTempHome, mainWindowSize, resetSharedApp, openTestProject, openView, resizeMainWindow, openSwimLanes } from './helpers'

// The timeline's own journeys share ONE Electron launch (each used to start the
// app for itself, which was most of this suite's wall-clock). Each describe
// below keeps its old spec's name and resets what a neighbour could have left
// behind — window size, zoom, localStorage — and opens a project of its own.
// None reads another's state, so a describe that fails and is retried on a
// fresh worker finds everything it needs.
//
// timeline-geometry runs first and owns the launch setup: a valid hook-config
// must exist before the app starts, and its stderr assertions read output from
// startup onwards.

let app: ElectronApplication
let page: Page
let tmpHome: string
let initialSize: [number, number]

const resetShared = (): Promise<void> => resetSharedApp(app, page, initialSize)
let stderr = ''
let stdout = ''

const EXCLUDED = '/tmp/redlog-verify-excluded'

test.beforeAll(async () => {
  test.setTimeout(60_000)
  tmpHome = makeTempHome('redlog-timeline-track-')
  // P0-1 setup: a VALID hook-config must exist before the app starts, so
  // startProject() actually walks the read path we fixed.
  mkdirSync(join(tmpHome, '.redlog'), { recursive: true })
  writeFileSync(
    join(tmpHome, '.redlog', 'hook-config.json'),
    JSON.stringify({ excludedPaths: [EXCLUDED], watchPaths: [] }, null, 2)
  )
  const launched = await launchWithTempHome(undefined, {
    home: tmpHome,
    onLaunch: (launching) => {
      const proc = launching.process()
      proc.stderr?.on('data', (b: Buffer) => { stderr += b.toString() })
      proc.stdout?.on('data', (b: Buffer) => { stdout += b.toString() })
    }
  })
  app = launched.app
  page = launched.page
  initialSize = await mainWindowSize(app)
})

test.afterAll(async () => { if (app) await app.close() })


// Timeline geometry + startup-gate regressions. These drive the real app
// because none of them are reachable from unit tests: the hook-config read
// happens in the main-process startup path, and the other two are renderer
// layout/geometry. All three shipped as bugs before v0.9.4 — P0-1 in
// particular survived several releases precisely because nothing covered it.
test.describe.serial('timeline-geometry: timeline geometry + startup gates', () => {
  test.beforeAll(async () => {
    await resetShared()
    await openTestProject(page, 'timeline-geometry')
  })

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
    await resizeMainWindow(app, 1280, 620)
    await openSwimLanes(page)
    await page.waitForTimeout(1500)
  })

  // ---------------------------------------------------------------- P0-2
  test('lane stack scrolls vertically instead of clipping (v0.9.4 P0-2)', async () => {
    // Lanes now open banded (§6). Expand every band so all 18 lanes show, which
    // is the many-rows overflow scenario this test exists for.
    for (const b of ['commands', 'traffic', 'artifacts', 'signals']) {
      const chip = page.locator(`[data-testid="timeline-band-${b}"]`)
      if (await chip.count()) await chip.click()
    }
    await page.waitForTimeout(200)
    const geom = await page.evaluate(() => {
      // By testid, not by class. `div.overflow-y-auto.min-h-0` matched the
      // sidebar once it became scrollable too, and querySelector handed back
      // the first match — so this read the nav's geometry and reported two
      // lanes with no error.
      const outer = document.querySelector('[data-testid="timeline-lane-scroll"]') as HTMLElement | null
      if (!outer) return null
      const labels = outer.firstElementChild as HTMLElement
      return {
        scrollHeight: outer.scrollHeight,
        clientHeight: outer.clientHeight,
        laneRows: labels ? labels.children.length - 1 : 0
      }
    })
    expect(geom, 'scroll container not found').not.toBeNull()
    // 18 lanes plus the four band headings, which stay put when expanded so the
    // grouping does not vanish the moment a band gains children.
    expect(geom!.laneRows, 'expected all 18 lanes under their four bands').toBe(22)
    expect(geom!.scrollHeight, 'lane stack should overflow at this height')
      .toBeGreaterThan(geom!.clientHeight)

    // And it must actually scroll — the bug was that it could not.
    const scrolled = await page.evaluate(() => {
      const outer = document.querySelector('[data-testid="timeline-lane-scroll"]') as HTMLElement
      outer.scrollTop = 9999
      return outer.scrollTop
    })
    expect(scrolled, 'container did not scroll vertically').toBeGreaterThan(0)
    await page.screenshot({ path: 'e2e/screenshots/timeline-lane-scroll.png' })
  })

  // ---------------------------------------------------------------- P0-3
  test('every dot renders inside the track (v0.9.4 P0-3)', async () => {
    await page.evaluate(() => {
      const outer = document.querySelector('[data-testid="timeline-lane-scroll"]') as HTMLElement
      outer.scrollTop = 0
    })
    const res = await page.evaluate(() => {
      const scroll = document.querySelector('div.cursor-grab') as HTMLElement | null
      if (!scroll) return null
      const track = scroll.firstElementChild as HTMLElement
      // `offsetWidth`, not `getBoundingClientRect().width`. The app renders
      // at `body { zoom: 0.9 }`, and the two disagree under zoom: the rect is
      // in device pixels (2000 × 0.9 = 1800) while `offsetLeft` below is in
      // CSS pixels. Comparing them made a dot at 1898 of a 2000px track read
      // as 98px outside it — an assertion failing on arithmetic rather than
      // on anything that was wrong with the track.
      const trackW = track.offsetWidth
      const dots = Array.from(document.querySelectorAll('[data-timeline-event]')) as HTMLElement[]
      const xs = dots.map((d) => d.offsetLeft)
      return { trackW, count: dots.length, min: Math.min(...xs), max: Math.max(...xs) }
    })
    expect(res, 'track not found').not.toBeNull()
    expect(res!.count, 'no dots rendered').toBeGreaterThan(0)
    expect(res!.min, 'a dot rendered left of the track').toBeGreaterThanOrEqual(0)
    expect(res!.max, 'a dot rendered past the track width').toBeLessThanOrEqual(res!.trackW)
    // Visual evidence: reset the zoom (100% is the whole domain since
    // 2026-11-08) and both scroll axes so the real events at the left edge and
    // the far-future marker at the right are on screen at once.
    const reset = page.getByTestId('timeline-zoom-reset')
    if (await reset.isEnabled()) await reset.click()
    await page.evaluate(() => {
      const outer = document.querySelector('[data-testid="timeline-lane-scroll"]') as HTMLElement
      const scroll = document.querySelector('div.cursor-grab') as HTMLElement
      if (outer) outer.scrollTop = 0
      if (scroll) scroll.scrollLeft = 0
    })
    await page.waitForTimeout(400)
    await page.screenshot({ path: 'e2e/screenshots/timeline-marker-domain.png' })
  })
})

// v0.11.4 (AUDIT V1/V2/V3): what the track says without being clicked.
//
// Severity and scope violations had no visual encoding at all. A `critical`
// marker rendered identically to an `info` one — severity was a text prefix
// inside the title — and a scope violation was distinguished only by its lane,
// in a red byte-identical to the marker lane's. Meanwhile chain integrity,
// which is rare and already announced by a banner, had a badge, a ring and a
// red band.
//
// Encoded as SHAPE rather than more colour: eighteen lane hues are past
// reliable discrimination, and shape survives a colour-blind operator and a
// glance at the far edge of the screen.
//
// The "no two lanes share a colour" invariant lives in
// test/lane-colours.test.ts — it is a property of a constant, and empty lanes
// auto-collapse so the DOM never shows all eighteen at once.


const dots = (p: Page): Promise<Array<{ title: string; radius: string; rotated: boolean; filled: boolean; width: number }>> =>
  p.evaluate(() => Array.from(document.querySelectorAll('[data-timeline-event]')).map((el) => {
    const inner = el.firstElementChild as HTMLElement
    const cs = getComputedStyle(inner)
    return {
      title: (el as HTMLElement).title,
      radius: cs.borderRadius,
      rotated: cs.transform !== 'none',
      filled: cs.backgroundColor !== 'rgba(0, 0, 0, 0)',
      width: Math.round(parseFloat(cs.width))
    }
  }))

test.describe.serial('timeline-encoding: timeline visual encoding', () => {
  test.beforeAll(async () => {
    await resetShared()
    await openTestProject(page, 'encoding')
    await page.waitForTimeout(1500)
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
    const post = (agent_type: string, data: Record<string, unknown>): Promise<Response> =>
      fetch(`${base}/api/events/seed`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type, data }) })
    // Spread the markers in time. Posted back-to-back they land in the same
    // 14px cluster bucket and render as one counted node, which would test the
    // clustering rather than the severity encoding. `atTimestamp` is honoured
    // by displayTs for markers, and the domain follows displayTs since v0.9.4.
    const now = Date.now()
    await post('shell', { subtype: 'command_end', command: 'id', exit_code: 0 })
    await post('marker', { title: 'info mark', severity: 'info', atTimestamp: now - 40 * 60_000 })
    await post('marker', { title: 'important mark', severity: 'important', atTimestamp: now - 25 * 60_000 })
    await post('marker', { title: 'CRITICAL mark', severity: 'critical', atTimestamp: now - 10 * 60_000 })
    // Placed in time like the markers above it, and for the same reason: left
    // at receipt time it shares a 14px cluster bucket with the project's own
    // genesis rows and renders as a counted node instead of its own dot.
    // `atTimestamp` is no help — displayTs honours that for markers only — so
    // this uses `source_timestamp`, which insertEvent validates and writes as
    // the row's real timestamp (provenance kept in ts_source).
    await post('system', { subtype: 'scope_violation', description: 'out of scope: evil.example', source_timestamp: now - 15 * 60_000 })
    await page.waitForTimeout(2000)
    await resizeMainWindow(app, 1500, 1000)
    // Zoom out so the whole span is on screen — the track only renders what is
    // near the viewport since v0.11.1.
    await page.evaluate(() => localStorage.setItem('redlog-timeline-zoom', '0.25'))
    await page.reload()
    await page.waitForTimeout(2500)
    await openSwimLanes(page)
    await page.waitForTimeout(2000)
  })


  test('an out-of-scope observation is a diamond, not another red circle', async () => {
    const d = (await dots(page)).find((x) => /out of scope/i.test(x.title))
    expect(d, 'the out-of-scope observation did not render').toBeTruthy()
    // Diamond = a slightly-rounded square, rotated 45°.
    expect(d!.rotated, 'must be rotated into a diamond').toBe(true)
    expect(d!.radius).not.toBe('50%')
    expect(d!.width, 'and drawn larger than an ordinary dot').toBeGreaterThan(9)
  })

  test('marker severity changes the mark; info stays an ordinary dot', async () => {
    const all = await dots(page)
    const info = all.find((x) => /info mark/.test(x.title))
    const important = all.find((x) => /important mark/.test(x.title))
    const critical = all.find((x) => /CRITICAL mark/.test(x.title))
    expect([info, important, critical].every(Boolean), 'all three markers should render').toBe(true)

    expect(info!.radius, 'info is a plain circle').toBe('50%')
    expect(info!.filled).toBe(true)
    expect(info!.width).toBe(9)

    expect(important!.width, 'important is larger than info').toBeGreaterThan(info!.width)
    expect(important!.filled).toBe(true)

    // Critical reads as an outline — the strongest signal available without
    // inventing another colour.
    expect(critical!.filled, 'critical is hollow').toBe(false)
    expect(critical!.width, 'critical is the largest').toBeGreaterThan(important!.width)
  })

  test('the tooltip names the emphasis, so shape is not the only channel', async () => {
    const all = await dots(page)
    expect(all.find((x) => /CRITICAL mark/.test(x.title))!.title).toMatch(/critical/i)
    expect(all.find((x) => /⚠ out of scope/i.test(x.title))!.title).toMatch(/out of scope/i)
  })

})

// docs/DESIGN-core-and-capture.md §6: the 18 lanes banded by capture group.
// The timeline opens as capture-group bands (collapsed), each expandable to its
// lanes, instead of a wall of eighteen. This is the product's most complex
// screen, so this verifies the real render: bands by default, expand reveals
// lanes, and the events are actually drawn (a band that shows no dots would be
// worse than eighteen lanes).


test.describe.serial('timeline-lane-bands: timeline lane bands', () => {
  test.beforeAll(async () => {
    await resetShared()
    await openTestProject(page, 'lane-bands')
    await page.waitForTimeout(1200)
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
    const post = (agent_type: string, data: Record<string, unknown>): Promise<Response> =>
      fetch(`${base}/api/events/seed`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type, data }) })
    // one event in each of the four bands
    await post('shell', { subtype: 'command_end', command: 'whoami' })                       // commands
    await post('scanner', { subtype: 'connection', proto: 'tcp', remote_addr: '10.0.0.9', remote_port: 445 }) // traffic
    await post('screenshot', { trigger: 'manual' })                                          // artifacts
    await post('marker', { title: 'note', severity: 'info' })                                // signals
    await page.waitForTimeout(600)
    await openSwimLanes(page)
    // Wait for the band row to render rather than a fixed sleep — under full-
    // suite load the render can lag past a fixed timeout.
    await page.locator('[data-testid="timeline-band-commands"]').waitFor({ state: 'visible', timeout: 10_000 })
  })

  test('opens as capture-group bands, not eighteen lanes', async () => {
    await expect(page.locator('[data-testid="timeline-band-commands"]')).toBeVisible()
    await expect(page.locator('[data-testid="timeline-band-traffic"]')).toBeVisible()
    await expect(page.locator('[data-testid="timeline-band-artifacts"]')).toBeVisible()
    await expect(page.locator('[data-testid="timeline-band-signals"]')).toBeVisible()
    // The band rows collapse many lanes into four; far fewer than 18 rows.
    const bandRows = await page.locator('[data-testid^="timeline-band-"]').count()
    expect(bandRows).toBeLessThanOrEqual(4)
  })

  test('the collapsed bands still draw their events', async () => {
    // A band that hid its dots would defeat the point. Dots render in the track.
    const dots = await page.locator('[data-timeline-event]').count()
    expect(dots, 'no events rendered in the collapsed bands').toBeGreaterThan(0)
  })

  test('clicking a band expands it into its lanes, and the band stays', async () => {
    await page.locator('[data-testid="timeline-band-commands"]').click()
    // Expanding adds the lanes under the band; it does not replace the band.
    // Replacing it meant the grouping the operator navigates by vanished at
    // the moment it gained children, which read as the category disappearing.
    await expect(page.locator('[data-testid="timeline-band-commands"]')).toBeVisible()
    await expect(page.locator('[data-testid="timeline-band-commands"]')).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('[data-testid="timeline-lane-shell"]')).toBeVisible()
  })

  test('hiding a lane keeps its row, struck through, and clicking it restores', async () => {
    // The row is the only control that can bring the lane back, so removing it
    // on hide left the operator with nothing to click.
    const shell = page.locator('[data-testid="timeline-lane-shell"]')
    await expect(shell).toHaveAttribute('aria-pressed', 'true')
    await shell.click()
    await expect(shell).toBeVisible()
    await expect(shell).toHaveAttribute('aria-pressed', 'false')
    await shell.click()
    await expect(shell).toHaveAttribute('aria-pressed', 'true')
  })
})

// Real idle-gap compression and keyboard access. Pure zoom/time-map behavior
// lives in test/timeline-geometry.test.ts and test/timeline-time-map.test.ts.


test.describe.serial('timeline-presentation: timeline presentation', () => {
  test.beforeAll(async () => {
    await resetShared()
    await openTestProject(page, 'presentation')
    await page.waitForTimeout(1500)
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
    const post = (t: string, d: Record<string, unknown>): Promise<Response> =>
      fetch(`${base}/api/events`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type: t, data: d }) })
    // Two bursts of work three hours apart — the shape V7 exists for.
    const now = Date.now()
    for (let i = 0; i < 6; i++) await post('marker', { title: `early ${i}`, severity: 'info', atTimestamp: now - 3 * 3600_000 - i * 30_000 })
    for (let i = 0; i < 6; i++) await post('marker', { title: `late ${i}`, severity: 'info', atTimestamp: now - i * 30_000 })
    await page.waitForTimeout(2000)
    await page.evaluate(() => localStorage.setItem('redlog-timeline-zoom', '1'))
    await page.reload()
    await page.waitForTimeout(2500)
    await openSwimLanes(page)
    await page.waitForTimeout(1500)
  })


  test('event dots are buttons a keyboard and a screen reader can reach', async () => {
    // They were plain divs with a click handler: no role, no label, no tab
    // stop. The existing up/down walk only engaged after a mouse click had
    // already selected something, so a keyboard-only operator could not reach
    // the track at all.
    const dot = await page.evaluate(() => {
      const el = document.querySelector('[data-timeline-event]') as HTMLElement | null
      return el && { tag: el.tagName, label: el.getAttribute('aria-label'), tabindex: el.getAttribute('tabindex') }
    })
    expect(dot?.tag).toBe('BUTTON')
    expect(dot?.label, 'needs a label — the visual is a 9px dot').toBeTruthy()

    // Roving tabindex: exactly one tab stop, so Tab crosses the track in one
    // press instead of stepping through every visible node.
    const stops = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-timeline-event]'))
        .filter((el) => el.getAttribute('tabindex') === '0').length)
    expect(stops).toBeLessThanOrEqual(1)
  })

  test('the skip-idle chip appears only when there is something to skip', async () => {
    // Detection has to run whether or not compression is on, or the control
    // that turns it on can never appear. That claim is unchanged; where the
    // control lives is not. #86 moved the rare view controls out of the flat
    // toolbar into the overflow menu (see the timeline-toolbar-overflow describe in this file),
    // and the role moved with it — `menuitemcheckbox`, not a bare button. The
    // old locator matched nothing, which is a stale test, not a lost feature:
    // the render condition it guards, `timeMap.gaps.length > 0 ||
    // compressGaps`, is still what decides whether the row exists at all.
    await page.locator('[data-testid="timeline-more-menu"]').click()
    const chip = page.getByRole('menuitemcheckbox', { name: /skip idle/i })
    await expect(chip).toBeVisible()
    // Off, and offering itself — which is only possible if gap detection ran
    // with compression disabled.
    await expect(chip).toHaveAttribute('aria-checked', 'false')
  })

  test('compressing collapses the gap and keeps the operator in place', async () => {
    const before = await page.evaluate(() => {
      const s = document.querySelector('div.cursor-grab') as HTMLElement
      return Array.from(document.querySelectorAll('[data-timeline-event]')).filter((d) => {
        const x = (d as HTMLElement).offsetLeft
        return x >= s.scrollLeft && x <= s.scrollLeft + s.clientWidth
      }).length
    })

    // The menu is still open from the previous test in this serial describe;
    // click it open if something closed it, then toggle compression on.
    const menu = page.getByRole('menuitemcheckbox', { name: /skip idle/i })
    if (await menu.count() === 0) await page.locator('[data-testid="timeline-more-menu"]').click()
    await page.getByRole('menuitemcheckbox', { name: /skip idle/i }).click()
    await page.waitForTimeout(900)

    const after = await page.evaluate(() => {
      const s = document.querySelector('div.cursor-grab') as HTMLElement
      return {
        gaps: document.querySelectorAll('[title*="no events, collapsed"]').length,
        label: (document.querySelector('[title*="no events, collapsed"]') as HTMLElement)?.textContent?.trim(),
        onScreen: Array.from(document.querySelectorAll('[data-timeline-event]')).filter((d) => {
          const x = (d as HTMLElement).offsetLeft
          return x >= s.scrollLeft && x <= s.scrollLeft + s.clientWidth
        }).length
      }
    })

    expect(after.gaps, 'the three-hour idle stretch should collapse').toBeGreaterThan(0)
    // The break is drawn, not implied — a discontinuity the operator cannot
    // see is worse than the wasted space it replaced.
    expect(after.label, 'the break carries its duration').toMatch(/\d+[hm]/)
    // And the viewport is re-anchored: the mapping changes under a fixed
    // scrollLeft, so without re-centring the operator lands on empty track.
    expect(after.onScreen, `dots on screen went ${before} -> ${after.onScreen}`).toBeGreaterThan(0)
  })
})

// Spec 069 US4 / FR-008: the Timeline opens as a standard, single-track
// sequential view; the swim lanes are the "advanced" mode one click away.
// Selection and zoom belong to the Timeline, not to either mode.


test.describe.serial('timeline-standard-mode: timeline standard / swim-lane modes', () => {
  // A click on the selected event deselects it, and these tests run in order
  // on one window: select whoami only when it is not already the open one.
  const selectWhoami = async (): Promise<void> => {
    const panel = page.getByTestId('timeline-detail-panel')
    if (!(await panel.isVisible()) || !(await panel.textContent())?.includes('whoami')) {
      await page.getByRole('button', { name: /whoami/ }).first().click()
    }
    await expect(panel).toContainText('whoami')
  }

  test.beforeAll(async () => {
    await resetShared()
    await openTestProject(page, 'tl-mode')
    await page.waitForTimeout(1200)
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
    const post = (agent_type: string, data: Record<string, unknown>): Promise<Response> =>
      fetch(`${base}/api/events/seed`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type, data }) })
    await post('shell', { subtype: 'command_end', command: 'whoami', exit_code: 0 })
    await post('marker', { title: 'mode-note', severity: 'info' })
    await page.waitForTimeout(600)
    await openView(page, 'timeline')
    await page.getByTestId('timeline-mode-standard').waitFor({ state: 'visible', timeout: 10_000 })
  })

  test('opens in standard mode: one track of every event, no swim-lane rows', async () => {
    await expect(page.getByTestId('timeline-mode-standard')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('timeline-standard-track')).toBeVisible()
    await expect(page.locator('[data-testid^="timeline-band-"]')).toHaveCount(0)
    // The shell command AND the Evidence marker share the one track.
    expect(await page.locator('[data-timeline-event]').count()).toBeGreaterThanOrEqual(2)
    await expect(page.getByRole('button', { name: /whoami/ }).first()).toBeVisible()
  })

  // 2026-11-08 Stitch audit: 100% is the whole span, so there is nothing to
  // scroll to. Centred end labels hung past the track and made it scroll a few
  // pixels, clipped as ":12" and "03:". Widths are CSS px on both sides.
  test('at 100% the track does not scroll, and the end labels sit inside it', async () => {
    const reset = page.getByTestId('timeline-zoom-reset')
    if (await reset.isEnabled()) await reset.click()
    await expect(page.getByTestId('timeline-zoom-level')).toHaveText('100%')
    await expect.poll(() => page.evaluate(() => {
      const s = document.querySelector('div.cursor-grab') as HTMLElement
      return s.scrollWidth - s.clientWidth
    })).toBeLessThanOrEqual(1)
    const labels = page.getByTestId('timeline-axis-label')
    if (await labels.count() > 1) {
      await expect(labels.first()).not.toHaveAttribute('data-align', 'end')
      await expect(labels.last()).not.toHaveAttribute('data-align', 'start')
    }
  })

  test('the ruler has no lane label column and marks the newest event; the focus marker follows the selection', async () => {
    // The track is the scroller's first child: nothing sits left of it.
    const firstIsTrack = await page.evaluate(() =>
      (document.querySelector('[data-testid="timeline-lane-scroll"]')?.firstElementChild as HTMLElement | null)?.classList.contains('cursor-grab'))
    expect(firstIsTrack).toBe(true)
    await expect(page.getByTestId('timeline-marker-latest')).toBeVisible()
    await expect(page.getByTestId('timeline-marker-focus')).toHaveCount(0)
    // A named single event, not the first node: the first can be a cluster
    // ("4 events") sitting under another dot.
    await selectWhoami()
    await expect(page.getByTestId('timeline-marker-focus')).toBeVisible()
    // Same family of units as the dots: offsetLeft, never a bounding rect.
    const inTrack = await page.evaluate(() => {
      const track = (document.querySelector('div.cursor-grab') as HTMLElement).firstElementChild as HTMLElement
      return ['timeline-marker-focus', 'timeline-marker-latest'].map((id) => {
        const m = document.querySelector(`[data-testid="${id}"]`) as HTMLElement
        return m.offsetLeft >= 0 && m.offsetLeft <= track.offsetWidth
      })
    })
    expect(inTrack).toEqual([true, true])
    await page.getByTestId('timeline-marker-latest').click()
    await expect(page.getByTestId('timeline-follow-badge')).toContainText(/Live|即時/)
  })

  test('the toolbar Activity link opens the activity log and returns to the selected event', async () => {
    await selectWhoami()
    await page.getByTestId('timeline-open-activity').click()
    await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'search')
    await page.getByTestId('activity-return').getByRole('button').click()
    await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'timeline')
    await expect(page.getByTestId('timeline-detail-panel')).toContainText('whoami')
  })

  test('switching to swim lanes keeps the selection and the zoom', async () => {
    // The Activity-link test before this one comes back with whoami still
    // selected, and a click on the selected event deselects it. Select only if
    // nothing is open, so this test owns its precondition.
    if (!(await page.getByTestId('timeline-detail-panel').isVisible())) {
      await page.getByRole('button', { name: /whoami/ }).first().click()
    }
    await expect(page.getByTestId('timeline-detail-panel')).toContainText('whoami')
    await page.getByRole('button', { name: /Zoom in/ }).click()
    const zoom = await page.getByTestId('timeline-zoom-level').textContent()
    await page.getByTestId('timeline-mode-lanes').click()
    await expect(page.getByTestId('timeline-standard-track')).toHaveCount(0)
    await expect(page.locator('[data-testid^="timeline-band-"]').first()).toBeVisible()
    await expect(page.getByTestId('timeline-detail-panel')).toBeVisible()
    await expect(page.getByTestId('timeline-detail-panel')).toContainText('whoami')
    expect(await page.getByTestId('timeline-zoom-level').textContent()).toBe(zoom)
  })

  test('swim lanes show their own header and hide the bottom list; the header folds back', async () => {
    // Lanes mode (user decision 2026-11-08): the list is hidden, as in the
    // Stitch prototype. The selection still opens in the detail pane.
    await expect(page.getByTestId('timeline-mode-lanes')).toHaveAttribute('aria-pressed', 'true')
    const header = page.getByTestId('timeline-lanes-header')
    await expect(header).toBeVisible()
    await expect(page.getByTestId('timeline-lanes-active')).toContainText(/\d+/)
    await expect(page.getByTestId('timeline-log-resize')).toHaveCount(0)
    await expect(page.getByTestId('timeline-detail-panel')).toBeVisible()
    await page.getByTestId('timeline-lanes-collapse').click()
    await expect(page.getByTestId('timeline-mode-standard')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('timeline-lanes-header')).toHaveCount(0)
    await expect(page.getByTestId('rail-count')).toBeVisible()
    // The next test reads the choice back, so leave lanes selected.
    await page.getByTestId('timeline-mode-lanes').click()
  })

  test('the choice is remembered for the project', async () => {
    await expect(page.getByTestId('timeline-mode-lanes')).toHaveAttribute('aria-pressed', 'true')
    await openView(page, 'dashboard')
    await openView(page, 'timeline')
    await expect(page.getByTestId('timeline-mode-lanes')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('timeline-standard-track')).toHaveCount(0)
    await page.getByTestId('timeline-mode-standard').click()
    await expect(page.getByTestId('timeline-standard-track')).toBeVisible()
  })
})

// docs/DESIGN-core-and-capture.md §6: the eight flat toolbar toggles grouped by
// effect. The low-frequency view controls (session dividers, timezone) moved
// behind one "More" control so the row is scannable instead of a flat wall of
// chips. This checks they are reachable there, not lost. The auditor view left
// the menu in spec 038: "Chained only" is a FilterBar chip every view applies.


test.describe.serial('timeline-toolbar-overflow: timeline toolbar overflow', () => {
  test.beforeAll(async () => {
    await resetShared()
    await openTestProject(page, 'toolbar-overflow')
    await openView(page, 'timeline')
  })

  const boundaries = (): ReturnType<Page['getByRole']> =>
    page.getByRole('menuitemcheckbox', { name: /Session boundaries/ })

  test('the rare view controls are not in the flat row', async () => {
    // The session-boundaries toggle should NOT be visible until the overflow
    // is opened — that is the whole point of moving it.
    await expect(boundaries()).toHaveCount(0)
    await expect(page.locator('[data-testid="timeline-more-menu"]')).toBeVisible()
  })

  test('the overflow reveals them and they still work', async () => {
    await page.locator('[data-testid="timeline-more-menu"]').click()
    await expect(boundaries()).toBeVisible()
    // Spec 038: the zone and the tier are not Timeline settings. The zone is
    // chosen in Settings ▸ General; the tier is the FilterBar chip (SC-007).
    await expect(page.locator('[data-testid="timeline-tz-select"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="timeline-auditor-view-chip"]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Chained only/ })).toBeVisible()
    // Toggling through the menu persists to localStorage.
    const before = await page.evaluate(() => localStorage.getItem('redlog-timeline-session-dividers'))
    await boundaries().click()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('redlog-timeline-session-dividers')))
      .toBe(before === '0' ? '1' : '0')
  })

  test('the menu closes on outside click', async () => {
    await page.mouse.click(5, 5)
    await expect(boundaries()).toHaveCount(0)
  })
})

// The detail body's top row carries the ways out of an event — ask what else
// was running around it, exclude it from the export — and stepping to the
// previous or next one is on the bottom bar, which stays put. The body scrolls,
// and the row used to scroll with it: read past the first screen and the
// controls meant scrolling back up to find them.
//
// Every measurement here is a client rect. Mixing them with `offset*` under
// `body { zoom }` compares device pixels against CSS ones (CLAUDE.md).


test.describe.serial('timeline-detail-header: timeline detail header', () => {
  test.beforeAll(async () => {
    await resetShared()
    await openTestProject(page, 'detail-header')

    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
    // Far enough apart not to cluster: neighbouring events collapse into one
    // dot labelled "(2 events)", which no per-event locator can reach. That
    // holds for the project's own genesis rows too — they land at receipt
    // time, so a seed left at `now` clusters with them and the per-event
    // locator finds nothing.
    const now = Date.now()
    const when = { 'first event': now - 7_200_000, 'header pin event': now - 120_000 }
    for (const [title, atTimestamp] of Object.entries(when)) {
      await fetch(`${base}/api/events/seed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type: 'marker', data: { subtype: 'created', title, atTimestamp } })
      })
    }
    await openSwimLanes(page)
    await page.waitForTimeout(1500)
  })


  test('keeps the step and export controls on screen while the pane scrolls', async () => {
    // A click selects and shows the bottom bar, with the step controls; the
    // body (and its pinned header) opens on a double-click.
    await page.locator('[data-timeline-event][aria-label*="header pin event"]').first().click()
    await expect(page.getByTestId('timeline-detail-panel')).toBeVisible()
    await expect(page.getByTestId('timeline-detail-body')).toHaveCount(0)
    await expect(page.getByTestId('detail-step-prev')).toBeVisible()
    await page.locator('[data-timeline-event][aria-label*="header pin event"]').first().dblclick()
    const panel = page.getByTestId('timeline-detail-body')
    await expect(panel).toBeVisible()

    // Where the control ends up, not how it was pinned. `sticky`, or a header
    // lifted out of the scrolling body, or anything else — this asks only
    // whether the operator can still reach it from the bottom of the pane.
    const pinned = await page.evaluate(() => {
      const pane = document.querySelector('[data-testid="timeline-detail-body"]') as HTMLElement
      const step = document.querySelector('[data-testid="detail-around-event"]') as HTMLElement
      // If there is nothing to scroll, the row cannot have gone anywhere and
      // this would pass for the wrong reason. Report it rather than assert.
      const room = pane.scrollHeight - pane.clientHeight
      pane.scrollTop = room
      const p = pane.getBoundingClientRect()
      const s = step.getBoundingClientRect()
      return { room, scrolled: pane.scrollTop, aboveTop: p.top - s.top, belowBottom: s.bottom - p.bottom }
    })

    expect(pinned.room, 'the pane has nothing to scroll, so this proves nothing').toBeGreaterThan(20)
    // Inside the pane's visible box, within a pixel of rounding, after
    // scrolling to the very end.
    expect(pinned.aboveTop).toBeLessThan(2)
    expect(pinned.belowBottom).toBeLessThan(2)
    // And usable where it sits, not merely painted there.
    await expect(page.getByTestId('detail-around-event')).toBeVisible()
  })
})

// v0.11.1: the track renders only the clusters near the viewport.
//
// Every cluster across the whole track used to be in the DOM regardless of
// where the operator was looking — at max zoom that is a 12000px track behind
// a ~1200px window, so roughly 90% of the nodes existed only to be scrolled
// past. Measured here: 400 nodes before, 50 after, for the same 13200px track.
//
// Verified discriminating: disabling the filter puts all 400 back and this
// test fails.
test.describe.serial('timeline-virtualisation', () => {
  test.beforeAll(async () => { await resetShared() })

  test('the track renders only the clusters near the viewport', async () => {
    test.setTimeout(300_000)
    await openTestProject(page, 'virt')
    await page.waitForTimeout(1500)
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()

    // Spread over an hour so clusters do not all collapse into one bucket.
    const now = Date.now()
    for (let i = 0; i < 600; i++) {
      await fetch(`${base}/api/events`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        // markers, because displayTs honours `atTimestamp` only for them —
        // shell events all land at server Date.now() and collapse into one bucket
        body: JSON.stringify({ agent_type: 'marker',
          data: { title: `m${i}`, severity: 'info', atTimestamp: now - (600 - i) * 6000 } }) })
    }
    await page.waitForTimeout(2500)
    await resizeMainWindow(app, 1400, 950)
    await openSwimLanes(page)
    await page.waitForTimeout(1500)
    // Zoom in hard so the track is far wider than the window.
    // Zoom is persisted; set it and reload rather than synthesising 40 wheel
    // events and hoping the anchor handshake settles where we want.
    await page.evaluate(() => localStorage.setItem('redlog-timeline-zoom', '6'))
    await page.reload()
    await page.waitForTimeout(2500)
    await openSwimLanes(page)
    await page.waitForTimeout(1800)

    const m = await page.evaluate(() => {
      const scroll = document.querySelector('div.cursor-grab') as HTMLElement
      const track = scroll.firstElementChild as HTMLElement
      return {
        // Both in CSS pixels. `getBoundingClientRect()` is in device pixels and
        // the app renders at `body { zoom: 0.9 }`, so pairing it with
        // `clientWidth` compares two different units. It survived here only
        // because the assertion below has an order of magnitude of headroom.
        trackW: track.offsetWidth,
        viewportW: scroll.clientWidth,
        domDots: document.querySelectorAll('[data-timeline-event]').length,
        scrollLeft: scroll.scrollLeft
      }
    })
    console.log('VIRT:', JSON.stringify(m))
    expect(m.trackW, 'zoom did not widen the track').toBeGreaterThan(m.viewportW * 2)
    // With the track several screens wide, only the on-screen window plus one
    // screen either side should be in the DOM.
    const maxExpected = Math.ceil((m.viewportW * 3) / 14) + 20
    expect(m.domDots, `${m.domDots} dots in the DOM for a ${m.trackW}px track`).toBeLessThan(maxExpected)
  })
})

// Stitch 05 重點視窗: the viewport frame on the density strip is a handle. Its
// body pans the track; a grip resizes it and the zoom follows on release.
// Positions come from boundingBox(), which is in the same space page.mouse
// moves in; the scroll offset is read as `scrollLeft` (CSS px) and only ever
// compared with itself.
test.describe.serial('timeline-focus-window: minimap focus window', () => {
  const scrollLeft = (): Promise<number> =>
    page.evaluate(() => (document.querySelector('div.cursor-grab') as HTMLElement).scrollLeft)

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    await resetShared()
    await openTestProject(page, 'focus-window')
    await page.waitForTimeout(1000)
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
    const now = Date.now()
    for (let i = 0; i < 30; i++) {
      await fetch(`${base}/api/events`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type: 'marker',
          data: { title: `fw${i}`, severity: 'info', atTimestamp: now - (30 - i) * 60_000 } }) })
    }
    // Zoomed in, so the window is a fraction of the strip with room to move.
    await page.evaluate(() => localStorage.setItem('redlog-timeline-zoom', '4'))
    await page.reload()
    await page.waitForTimeout(2000)
    await openView(page, 'timeline')
    await expect(page.getByTestId('minimap-window')).toBeVisible()
  })

  test('the strip is titled and says what span it covers', async () => {
    await expect(page.getByText(/^Event density/)).toBeVisible()
    await expect(page.getByTestId('minimap-span')).toHaveText(/\d{2}:\d{2}:\d{2} - \d{2}:\d{2}:\d{2}/)
  })

  test('dragging the window body pans the track', async () => {
    const before = await scrollLeft()
    const box = (await page.getByTestId('minimap-window').boundingBox())!
    expect(box.width, 'window should be narrower than the strip at zoom 4').toBeGreaterThan(10)
    const y = box.y + box.height / 2
    const x = box.x + box.width / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x - 80, y, { steps: 6 })
    await page.mouse.up()
    await expect.poll(scrollLeft).toBeLessThan(before - 20)
  })

  test('dragging a grip resizes the window and re-zooms on release', async () => {
    const zoomBefore = await page.getByTestId('timeline-zoom-level').textContent()
    const grip = (await page.getByTestId('minimap-window-start').boundingBox())!
    const y = grip.y + grip.height / 2
    const x = grip.x + grip.width / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x - 60, y, { steps: 6 })
    // The outline shows the new range while the grip is held.
    await expect(page.getByTestId('minimap-window-preview')).toBeVisible()
    await page.mouse.up()
    await expect(page.getByTestId('minimap-window-preview')).toHaveCount(0)
    // A wider window is a lower zoom.
    await expect.poll(() => page.getByTestId('timeline-zoom-level').textContent()).not.toBe(zoomBefore)
    const pct = (s: string | null): number => Number((s ?? '').replace(/[^\d.]/g, ''))
    expect(pct(await page.getByTestId('timeline-zoom-level').textContent())).toBeLessThan(pct(zoomBefore))
  })
})
