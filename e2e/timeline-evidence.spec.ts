import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, mainWindowSize, resetSharedApp, openTestProject, openView, openSettingsPage, resizeMainWindow, openSwimLanes, REPO_ROOT } from './helpers'

// What the timeline shows about events and their relationships, from a seeded
// project. One Electron launch for the file; each describe keeps its old spec's
// name, resets window size/zoom/localStorage, and opens a project of its own.
//
// connection-capture is last on purpose: it switches the Host monitors pack on,
// and nothing after it should find that on.

let app: ElectronApplication
let page: Page
let tmpHome: string
let initialSize: [number, number]

const resetShared = (): Promise<void> => resetSharedApp(app, page, initialSize)

test.beforeAll(async () => {
  test.setTimeout(60_000)
  const launched = await launchWithTempHome()
  app = launched.app
  page = launched.page
  tmpHome = launched.tmpHome
  initialSize = await mainWindowSize(app)
})

test.afterAll(async () => { if (app) await app.close() })

test.describe.serial('command-artifact-correlation: command artifact correlation', () => {
  test.beforeAll(async () => {
    await resetShared()
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
    await openSwimLanes(page)
    await page.waitForTimeout(800)
  })


  test('labels cwd overlap as a possible relationship rather than causation', async () => {
    const file = page.locator('[data-timeline-event][aria-label*="scan.xml"]')
    await expect(file).toBeVisible()
    // The related-commands note lives in the detail body, which a double-click
    // opens (a single click only selects and shows the bottom bar).
    await file.dblclick()
    await expect(page.getByText('Possible related commands')).toBeVisible()
    await expect(page.getByText(/does not prove which process wrote the file/)).toBeVisible()
    await expect(page.getByText('Caused by:')).toHaveCount(0)
  })
})

test.describe.serial('event-causal-chain: event causal chain', () => {
  test.beforeAll(async () => {
    await resetShared()
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
    // Two minutes back, not `now`: at `now` it shares a 14px cluster bucket
    // with the project's own genesis rows and renders as a counted node
    // ("(N events)") whose title no longer says "causal effect". Still the
    // newest row — the fillers stop ~33 minutes ago.
    await post({ subtype: 'created', title: 'causal effect', atTimestamp: now - 120_000, _causes: [parent.id] })

    await openSwimLanes(page)
    await page.waitForTimeout(1800)
  })


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

// Spec 038 (US2): arriving from a target sets the shared filter's target,
// the FilterBar chip every event view honours, instead of a Timeline-only
// focus that matched seven observation fields and dimmed the rest. The lanes
// stay, TargetView stays, and "what happened to 10.10.11.24" is answered by
// the same target_id predicate the Targets page counted.


test.describe.serial('target-focus: target focus on the timeline', () => {
  test.beforeAll(async () => {
    await resetShared()
    await openTestProject(page, 'target-focus')
    await page.waitForTimeout(1500)
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
    const post = (agent_type: string, data: Record<string, unknown>, target_id?: string): Promise<Response> =>
      fetch(`${base}/api/events/seed`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type, data, target_id }) })

    // Activity against two hosts, so focusing one must dim the other.
    await post('scanner', { subtype: 'connection', proto: 'tcp', remote_addr: '10.10.11.24',
      remote_port: 445, detectedTarget: '10.10.11.24' }, '10.10.11.24')
    await post('shell', { command: 'smbclient //10.10.11.24/share', detectedTarget: '10.10.11.24' }, '10.10.11.24')
    await post('scanner', { subtype: 'connection', proto: 'tcp', remote_addr: '10.10.11.99',
      remote_port: 22, detectedTarget: '10.10.11.99' }, '10.10.11.99')
    await page.waitForTimeout(600)
  })


  const arriveFromTarget = async (): Promise<void> => {
    await openView(page, 'targets')
    // Select the target and jump to the timeline via the keyboard path (§7:
    // the documented target → timeline route).
    await page.keyboard.press('ArrowDown')
    // Land on the 10.10.11.24 row deterministically by clicking it.
    await page.getByText('10.10.11.24', { exact: false }).first().click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
    await expect(page.locator('[data-testid="view-root"][data-view="timeline"]')).toBeVisible()
  }
  const chip = (): ReturnType<Page['getByText']> => page.getByText('Target: 10.10.11.24', { exact: true })

  test('arriving from a target sets the shared target chip', async () => {
    await arriveFromTarget()
    await expect(chip()).toBeVisible()
    await expect(page.locator('[data-testid="timeline-target-focus-badge"]')).toHaveCount(0)
  })

  test('the chip clears it', async () => {
    await page.getByRole('button', { name: 'Clear Target: 10.10.11.24', exact: true }).click()
    await expect(chip()).toHaveCount(0)
  })

  test('navigating away and back keeps the target, visibly', async () => {
    // FR-005: the target is the shared filter's, so it stays set across views
    // until cleared. It is not silent: the chip says so wherever it applies.
    await arriveFromTarget()
    await openView(page, 'dashboard')
    await openView(page, 'timeline')
    await expect(chip()).toBeVisible()
  })

  test('the Timeline offers the way back to the target it came from', async () => {
    // UI/UX audit F19 (§7): a jump to the Timeline is a detour, not a new
    // place to start over from.
    await arriveFromTarget()
    const back = page.getByTestId('timeline-return')
    await expect(back).toBeVisible()
    await back.getByRole('button').click()
    await expect(page.locator('[data-testid="view-root"][data-view="targets"]')).toBeVisible()
    // Arriving by the sidebar is not a detour: no way back is offered.
    await openView(page, 'timeline')
    await expect(page.getByTestId('timeline-return')).toHaveCount(0)
  })
})

// The "nothing folded under a command" warning names a remedy, and the remedy
// is not the same on the three platforms. It shipped naming only two of them:
// a Windows operator was told to go install `ss` or `lsof` — neither of which
// Windows uses, and neither of which was the problem, because `netstat -no`
// is always present and the missing half there is pid → command.
//
// What this spec can pin and what it cannot:
//
// A run happens on ONE host, so it cannot see all three strings at once —
// `blindCauseKey` is chosen at module scope from the preload's `platform`, and
// nothing a test can do from the renderer changes what the OS reports. So it
// pins the two halves that actually broke, on whichever host is running:
//
//   - this platform's remedy IS the one on screen, and
//   - no other platform's remedy is, which is the bug as it was reported.
//
// CI runs e2e on ubuntu, so the linux branch is the one that gets checked
// there; the win32 branch is checked by whoever runs this on Windows, which
// is where it was found. Both locales are asserted, because `t()` falls back
// to English on a missing key — a zh-TW translation could go missing and the
// line would still read fine in an English-locale test.


type Locale = 'en' | 'zh-TW'

const PLATFORM_KEYS = {
  win32: 'timeline.fold.blind.win32',
  darwin: 'timeline.fold.blind.darwin',
  linux: 'timeline.fold.blind.linux'
} as const

type PlatformKey = keyof typeof PLATFORM_KEYS

/** The platform this host is, as the renderer's `lib/platform` decides it:
 *  only `darwin` is a Mac, only `win32` is Windows, everything else is the
 *  linux branch (a BSD gets the `ss` line; that is the existing contract). */
const hostPlatform: PlatformKey =
  process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'

function strings(locale: Locale): Record<string, string> {
  const file = join(REPO_ROOT, 'src', 'renderer', 'src', 'i18n', `${locale}.json`)
  const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, string>
  // Read from the catalogue rather than copied into the spec: the wording is
  // allowed to change, naming the wrong platform is not. A missing key would
  // otherwise assert `undefined` against the line and pass.
  for (const key of ['timeline.fold.blind', ...Object.values(PLATFORM_KEYS)]) {
    expect(parsed[key], `${locale}.json is missing ${key}`).toBeTruthy()
  }
  return parsed
}

/** Set the locale and get back to a mounted Timeline: `detectLocale()` reads
 *  localStorage once on mount, so the switch needs a reload, and a reload
 *  lands on the dashboard.
 *
 *  The settle after `reload()` is not padding. The dashboard mounts the
 *  built-in terminal, so a reload tears a pty down and spawns another; on
 *  Windows, clicking into the sidebar while that is in flight took the whole
 *  app down with it — reported here as `page.click: Target page, context or
 *  browser has been closed` and an exit code of 0, which names nothing. */
async function showTimelineIn(locale: Locale): Promise<void> {
  await page.evaluate((l) => localStorage.setItem('redlog-locale', l), locale)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1500)
  await openView(page, 'timeline')
}

test.describe.serial('attribution-blind-copy: attribution-blind copy names this platform', () => {
  test.beforeAll(async () => {
    await resetShared()
    await openTestProject(page, 'blind-copy')
    await page.waitForTimeout(1500)

    // The line appears only when the join has been ASKED and has never once
    // answered (`attempted > 0 && resolved === 0`). One traffic event with no
    // pid and no source address is exactly that: socket-attribution counts the
    // attempt and resolves nothing, and nothing in an E2E run ever records a
    // hooked command_start to resolve against.
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
    const res = await fetch(`${base}/api/events/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        agent_type: 'scanner',
        data: { subtype: 'connection', proto: 'tcp', remote_addr: '10.10.11.24', remote_port: 445, detectedTarget: '10.10.11.24' }
      })
    })
    expect(res.status).toBe(201)
    await page.waitForTimeout(1500)
  })


  for (const locale of ['en', 'zh-TW'] as const) {
    test(`${locale}: the remedy is this host's, and no other platform's`, async () => {
      const t = strings(locale)
      await showTimelineIn(locale)

      const line = page.getByTestId('log-attribution-blind')
      await expect(line).toBeVisible()
      // The shared half: traffic arrived and the join answered nothing. It
      // must not go back to asserting a cause — "this host cannot read which
      // process owns a socket" is false on Windows, where it can.
      await expect(line).toContainText(t['timeline.fold.blind'])
      await expect(line).toContainText(t[PLATFORM_KEYS[hostPlatform]])

      for (const other of Object.keys(PLATFORM_KEYS) as PlatformKey[]) {
        if (other === hostPlatform) continue
        await expect(line, `${locale} line names ${other}'s remedy on ${hostPlatform}`)
          .not.toContainText(t[PLATFORM_KEYS[other]])
      }

      // A zh-TW key that goes missing renders the English string through
      // `t()`'s fallback, which reads as a correct line and is not one.
      if (locale === 'zh-TW') {
        await expect(line).not.toContainText(strings('en')[PLATFORM_KEYS[hostPlatform]])
      }
    })
  }
})

// Design turn 8b, end to end. Two things here can only be caught by the real
// bundle: the temporal-dead-zone crash that a memo referencing a const declared
// below it produces under esbuild (vitest transforms the source and never sees
// it — this file has caught that twice), and the claim that the effective
// marker is derived from data alone, which is only true if it survives a
// reload with no persisted UI state.


// The preload surface this spec drives. Declared locally and cast at each use,
// the way the other specs do it — e2e is not part of the renderer tsconfig, so
// `window.redlog` has no ambient type here.
interface AmendBridge {
  events: {
    runQuery: (req: { parsed: { conditions: unknown[]; text: string }; limit?: number }) =>
      Promise<{ items: Array<{ id: string; data: Record<string, unknown> }> }>
    getCount: (tier: 'chained' | 'logged' | 'all') => Promise<number>
  }
  chain: { verify: () => Promise<{ ok: boolean }> }
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

/** Make the amend panel for this marker be open.
 *
 *  Clicking a timeline event that is already selected deselects it — and the
 *  timeline now restores the last selection across a reload, so after one the
 *  panel is already open and a blind click *closes* the thing this helper
 *  exists to open. That is what broke `survives a reload`: the click landed on
 *  the restored selection, the panel went away, and the wait timed out at 10s
 *  on a selector that had been there a moment earlier.
 *
 *  Both call sites in this file name the same marker (it is renamed from
 *  'original title' to 'amended title' partway through), so "panel open" and
 *  "panel open on this marker" are the same question here. A third call site
 *  naming a different marker would need to check which one the panel shows. */
const selectMarker = async (titleText: string): Promise<void> => {
  if (await page.locator('[data-testid="marker-amend"]').count() > 0) return
  // The amend controls are in the detail body: double-click, not click.
  await page.dblclick(`[data-timeline-event][title*="${titleText}"]`)
  await page.waitForSelector('[data-testid="marker-amend"]', { timeout: 10_000 })
}

// The amend count is shown on the rail's rows, and lanes mode hides the rail
// (Stitch 05, user decision); these tests are about amending, not lanes, so
// they read the Timeline in standard mode.
const openStandard = async (): Promise<void> => {
  await openView(page, 'timeline')
  const standard = page.getByTestId('timeline-mode-standard')
  await standard.waitFor({ state: 'visible', timeout: 10_000 })
  if ((await standard.getAttribute('aria-pressed')) !== 'true') await standard.click()
  await page.getByTestId('timeline-standard-track').waitFor({ state: 'visible', timeout: 10_000 })
}

test.describe.serial('marker-amend: amending a marker', () => {
  test.beforeAll(async () => {
    await resetShared()
    await openTestProject(page, 'amend')
    await page.waitForTimeout(1500)
    await post('shell', { subtype: 'command_end', command: 'id', exit_code: 0 })
    await post('marker', { title: 'original title', severity: 'info', notes: 'first pass', atTimestamp: Date.now() - 10 * 60_000 })
    await page.waitForTimeout(1500)
    await resizeMainWindow(app, 1500, 1000)
    await page.evaluate(() => localStorage.setItem('redlog-timeline-zoom', '0.25'))
    await page.reload()
    await page.waitForTimeout(2500)
    await openStandard()
    await page.waitForTimeout(1500)
  })


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
      const { items: rows } = await (window as unknown as { redlog: AmendBridge }).redlog.events.runQuery({ parsed: { conditions: [], text: 'original title' }, limit: 50 })
      return rows.map((r) => ({ id: r.id, subtype: (r.data as Record<string, unknown>).subtype, title: (r.data as Record<string, unknown>).title }))
    })
    const original = stored.find((r) => !r.subtype)
    expect(original?.title).toBe('original title')

    const verdict = await page.evaluate(() => (window as unknown as { redlog: AmendBridge }).redlog.chain.verify())
    expect(verdict.ok).toBe(true)
  })

  test('survives a reload — the effective marker is derived, not remembered', async () => {
    await page.reload()
    await page.waitForTimeout(2500)
    await openStandard()
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
    await page.locator('#reading-tab-events').click()
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
    await openStandard()
    await page.waitForTimeout(2000)

    const html = await page.content()
    expect(html, 'a paging gap must never render as a broken chain').not.toContain('border-red-500/50')
  })

  test('a marker written while recording is paused still appears, with its drop point', async () => {
    const before = await page.evaluate(() => (window as unknown as { redlog: AmendBridge }).redlog.events.getCount('chained'))
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
    expect(await page.evaluate(() => (window as unknown as { redlog: AmendBridge }).redlog.events.getCount('chained'))).toBeGreaterThan(before)
    expect(await page.locator('[data-timeline-event][title*="written while paused"]').count()).toBeGreaterThan(0)
    await page.evaluate(() => (window as unknown as { redlog: AmendBridge }).redlog.recording.toggle())
  })
})

let apiBase: string
let apiToken: string

test.describe.serial('active-target-context: active target context', () => {
  test.beforeAll(async () => {
    await resetShared()
    await openTestProject(page, 'active-target-a')

    apiBase = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
    apiToken = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()
  })


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
    // The action sits inside the expanded target (Spec 069 T019).
    await page.getByText('10.10.11.99', { exact: true }).click()
    await page.getByRole('button', { name: 'Work on this' }).click()
    // The Targets page is now the control, so this is the case that matters
    // most: the one surface that can still set it, still does.
    await expect.poll(activeTarget).toBe('10.10.11.99')
  })
})

// docs/DESIGN-core-and-capture.md §2.1, verified in a running app.
//
// The connection monitor shells out to ss/netstat, which an e2e cannot drive
// deterministically — that path is covered by the parser fixtures in
// test/connection-table.test.ts. What this checks is the half an operator sees:
// a connection event lands on the timeline reading as a connection, and the
// capture is something they can turn on and see turned on. The seed door
// stands in for the poller so the render and the toggle are exercised for real.


test.describe.serial('connection-capture: connection-level capture', () => {
  test.beforeAll(async () => {
    await resetShared()
    await openTestProject(page, 'connection-capture')
    await page.waitForTimeout(1500)
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
    const post = (data: Record<string, unknown>): Promise<Response> =>
      fetch(`${base}/api/events/seed`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type: 'scanner', data }) })

    // A reverse shell: opened, then closed 90s later carrying its duration.
    await post({ subtype: 'connection', proto: 'tcp', remote_addr: '10.10.11.24',
      remote_port: 4444, local_port: 51001, detectedTarget: '10.10.11.24' })
    await post({ subtype: 'connection_end', proto: 'tcp', remote_addr: '10.10.11.24',
      remote_port: 4444, local_port: 51001, detectedTarget: '10.10.11.24', duration_sec: 90 })
    await page.waitForTimeout(600)
    await openView(page, 'timeline')
    await page.waitForTimeout(800)
  })


  // The two events sit in the Scanner lane. At the default zoom the timeline
  // may cluster them into a lane summary rather than two discrete dots, so
  // assert on the rendered text of the scanner lane, not on [data-timeline-event]
  // — the operator reads the summary either way.
  const timelineText = (): Promise<string> =>
    page.evaluate(() => document.querySelector('[data-testid="view-root"]')?.textContent ?? '')

  test('an established connection lands on the timeline as a connection', async () => {
    expect(await timelineText()).toContain('10.10.11.24:4444')
  })

  test('the close carries the duration — a span, not a bare point', async () => {
    expect(await timelineText()).toMatch(/closed.*90s/)
  })

  test('the operator can turn connection capture on and it sticks', async () => {
    await openView(page, 'settings')
    await openSettingsPage(page, 'captureControl')
    // Spec 035: connection capture is part of the Host monitors pack.
    const toggle = page.getByTestId('pack-switch-hostMonitors')
    await expect(toggle).toHaveCount(1)
    await toggle.check()
    // Settings autosaves on a 350ms debounce; wait for the round-trip to land
    // rather than reading config the instant the box flips.
    await expect.poll(async () => page.evaluate(async () =>
      (await (window as unknown as { redlog: { config: { get: () => Promise<Record<string, unknown>> } } })
        .redlog.config.get() as { packs?: { hostMonitors?: boolean } }).packs?.hostMonitors),
      { timeout: 5000 }
    ).toBe(true)
  })

  test('turning it on states the SYN-scan blind spot where the switch is', async () => {
    // The limitation must sit next to the control, not only in a doc — a
    // capture that silently misses a class of activity is worse than one that
    // admits its edge.
    await expect(page.getByText(/SYN scan/i)).toBeVisible()
  })
})
