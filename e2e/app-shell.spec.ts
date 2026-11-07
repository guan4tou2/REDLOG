import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, mainWindowSize, resetSharedApp, openTestProject, openView, openSettingsPage, resizeMainWindow, type RedLogBridge } from './helpers'

// The app's frame and first-hour flows: the project picker, workspace
// navigation, chrome, status bar, rename and scope entry. One Electron launch
// for the file; each describe keeps its old spec's name, resets window
// size/zoom/localStorage and opens (or leaves) a project as its own journey
// needs.
//
// project-flow is first on purpose: it asserts the project list holds exactly
// the one project it creates, which is only true before anything else runs.

let app: ElectronApplication
let page: Page
let tmpHome: string
let initialSize: [number, number]

const resetShared = (): Promise<void> => resetSharedApp(app, page, initialSize)

test.beforeAll(async () => {
  test.setTimeout(60_000)
  const launched = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP)
  app = launched.app
  page = launched.page
  tmpHome = launched.tmpHome
  initialSize = await mainWindowSize(app)
})

test.afterAll(async () => { if (app) await app.close() })

// Serial: test 1 opens a project, tests 2 & 3 exercise it. This describe must
// stay first in the file — it asserts the project list holds exactly the one it
// created, and it starts from the picker of a home with no projects.
test.describe.serial('project-flow: project flow', () => {
  test.beforeAll(async () => {
    await resetShared()
    await page.reload()
  })

  test('repeated Enter creates only one project and opens the dashboard', async () => {
    // Fresh HOME → no projects yet, so ProjectPicker owns the window.
    await expect(page).toHaveTitle(/RedLog/)
    await expect(page.locator('[data-testid="project-picker"]')).toBeVisible()

    await page.getByRole('button', { name: 'Create new project' }).click()
    const name = page.getByPlaceholder('e.g. Client-Pentest-Q3')
    await name.fill('e2e-flow')
    // Deliver key repeats before IPC can answer. This exercises the real
    // picker and project store, rather than creating a project through API.
    await name.evaluate(el => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    const viewRoot = page.locator('[data-testid="view-root"]')
    await expect(viewRoot).toHaveAttribute('data-view', 'dashboard')
    const projects = await page.evaluate(() => window.redlog.project.list())
    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({ name: 'e2e-flow', id: expect.any(String) })

    await page.screenshot({ path: test.info().outputPath('project-opened.png') })
  })

  test('primary workspace shortcuts and pinned settings switch views', async () => {
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    const viewRoot = page.locator('[data-testid="view-root"]')

    for (const [key, expected] of [
      ['2', 'search'],
      ['3', 'timeline'],
      ['4', 'http_history'],
      ['5', 'targets'],
      ['6', 'screenshots'],
      ['7', 'terminal'],
      ['1', 'dashboard'],
      ['9', 'settings']
    ] as const) {
      await page.keyboard.press(`${mod}+${key}`)
      await expect(viewRoot).toHaveAttribute('data-view', expected, { timeout: 2_000 })
    }
  })

  test('chain.verify() is ok on a fresh project', async () => {
    // A freshly opened project has only system events (api_started,
    // session_start, …) appended by the main process. Those are hashed into
    // the chain the same way user events are, so full verify should pass.
    const result = await page.evaluate(async () => {
      const bridge = (window as unknown as { redlog: RedLogBridge }).redlog
      return await bridge.chain.verify()
    })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    // verifyChainFull returns `brokenAtEventId: null` when the walk is clean;
    // treat undefined and null as the same "no break" signal so we don't
    // depend on that internal choice.
    expect(result.brokenAtEventId ?? null).toBeNull()
  })
})

test.describe.serial('view-reachability', () => {
  test.beforeAll(async () => {
    await resetShared()
    await openTestProject(page, 'reachability')
  })

  const viewRoot = (): ReturnType<Page['locator']> => page.locator('[data-testid="view-root"]')

  // #558: every view has to be reachable by someone who is looking at the screen,
  // not by someone who has read the documentation.
  //
  // The suite already navigated to each view, but `openView()` in helpers falls
  // back to the command palette when it cannot find a control — and that fallback
  // is exactly what hid the gap: `timeline` and `transcript` had no entrance on
  // any screen for months, and every navigation test still passed because the
  // helper went around the UI to prove the view worked.
  //
  // So this spec never touches the palette. It asserts, per view, that a visible
  // control exists and that pressing it lands there. A view that can only be
  // reached by typing its name is not reachable.
  test('the seven daily workspaces each have a sidebar control', async () => {
    for (const view of ['dashboard', 'search', 'timeline', 'http_history', 'targets', 'screenshots', 'terminal']) {
      const button = page.locator(`nav [data-view-btn="${view}"]`).first()
      await expect(button, `${view} has no sidebar row`).toBeVisible()
      await button.click()
      await expect(viewRoot()).toHaveAttribute('data-view', view)
    }
  })

  test('the timeline is reachable from the activity workspace, not only the palette', async () => {
    await page.locator('nav [data-view-btn="search"]').first().click()
    await expect(viewRoot()).toHaveAttribute('data-view', 'search')
    const entry = page.getByTestId('workspace-open-timeline')
    await expect(entry, 'the timeline has no in-page entrance').toBeVisible()
    await entry.click()
    await expect(viewRoot()).toHaveAttribute('data-view', 'timeline')
  })

  test('the activity page names itself, its time zone and offers a source filter', async () => {
    await page.locator('nav [data-view-btn="search"]').first().click()
    await expect(page.getByTestId('activity-title')).toHaveText('Activity')
    await expect(page.getByTestId('activity-zone')).toContainText(/Time zone: (UTC|local \(UTC[+-]\d)/)
    await expect(page.getByTestId('activity-source')).toHaveValue('')
    // The collapsed "more filters" entrance is the existing shared FilterBar.
    await expect(page.getByRole('button', { name: /Filters?/ }).first()).toHaveAttribute('aria-expanded', 'false')
  })

  test('the timeline is its own sidebar row on ⌘3, and entering it directly offers no way back', async () => {
    await page.locator('nav [data-view-btn="dashboard"]').first().click()
    const row = page.locator('nav [data-view-btn="timeline"]').first()
    await expect(row).toHaveAttribute('title', /Timeline · (⌘|Ctrl\+)3/)
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+3' : 'Control+3')
    await expect(viewRoot()).toHaveAttribute('data-view', 'timeline')
    await expect(row).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('timeline-return')).toHaveCount(0)
    // Activity is no longer the timeline's owner: its row is not the current one.
    await expect(page.locator('nav [data-view-btn="search"]').first()).not.toHaveAttribute('aria-current', 'page')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+7' : 'Control+7')
    await expect(viewRoot()).toHaveAttribute('data-view', 'terminal')
  })

  test('targets and scope share a heading, counted tabs and the state of the rules', async () => {
    await page.locator('nav [data-view-btn="targets"]').first().click()
    await expect(page.getByTestId('targets-scope-header').getByRole('heading', { level: 1 })).toHaveText('Targets & scope')
    await expect(page.getByTestId('tab-count-targets')).toBeVisible()
    // A fresh project declares no rules: said so, never shown as in scope.
    await expect(page.getByTestId('scope-context')).toContainText('Scope is not set')
    await page.locator('[data-view-btn="scope"][role="tab"]').click()
    await expect(viewRoot()).toHaveAttribute('data-view', 'scope')
    await expect(page.getByTestId('targets-scope-header')).toBeVisible()
    await page.getByTestId('targets-scope-settings').click()
    await expect(viewRoot()).toHaveAttribute('data-view', 'settings')
  })

  test('evidence shares a heading and counted tabs, and each page opens with its own controls', async () => {
    await page.locator('nav [data-view-btn="screenshots"]').first().click()
    const header = page.getByTestId('evidence-header')
    await expect(header.getByRole('heading', { level: 1 })).toHaveText('Evidence')
    // Screenshots and bookmarks are counted over the project; loot has no second number.
    await expect(page.getByTestId('tab-count-screenshots')).toBeVisible()
    await expect(page.getByTestId('tab-count-bookmarks')).toBeVisible()
    await expect(page.getByTestId('tab-count-loot')).toHaveCount(0)
    await page.locator('[data-view-btn="loot"][role="tab"]').click()
    await expect(viewRoot()).toHaveAttribute('data-view', 'loot')
    await expect(header).toBeVisible()
    await expect(page.getByTestId('loot-disclaimer')).toContainText('does not mean the credential works')
    await page.locator('[data-view-btn="bookmarks"][role="tab"]').click()
    await expect(viewRoot()).toHaveAttribute('data-view', 'bookmarks')
    await expect(header).toBeVisible()
  })

  test('the terminal names itself, explains its two capture tracks, and shows the active pane\'s state line', async () => {
    await page.locator('nav [data-view-btn="terminal"]').first().click()
    await expect(page.getByTestId('terminal-header').getByRole('heading', { level: 1 })).toHaveText('Terminal')
    await expect(page.getByTestId('terminal-session-meta')).toBeVisible()
    await expect(page.getByTestId('terminal-meta-screen')).toBeVisible()
    await page.getByTestId('terminal-about-open').click()
    const about = page.getByTestId('terminal-about')
    await expect(about).toContainText('Screen recording (.cast)')
    await expect(about).toContainText('Command events (shell hook)')
    await page.keyboard.press('Escape')
    await expect(about).toHaveCount(0)
  })

  test('the dashboard names itself, keeps shortcuts folded, and shows relay nodes only as a read of its own', async () => {
    // A project with nothing recorded opens the first-run page; one event takes
    // it past that, which is the dashboard this checks.
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()
    const seeded = await fetch(`${base}/api/events/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ agent_type: 'shell', data: { subtype: 'command_start', command: 'id' } })
    })
    expect(seeded.ok).toBe(true)
    await page.reload()
    await page.waitForSelector('[data-testid="view-root"][data-view="dashboard"]')
    const header = page.getByTestId('dashboard-header')
    await expect(header.getByRole('heading', { level: 1 })).toHaveText('Dashboard')
    const shortcuts = page.getByTestId('dashboard-shortcuts')
    await expect(shortcuts).not.toHaveAttribute('open', '')
    await shortcuts.locator('summary').click()
    await expect(shortcuts).toHaveAttribute('open', '')
    await expect(page.getByTestId('ip-status-card')).toBeVisible()
    await expect(page.getByTestId('ip-status-card')).not.toContainText('→')
    // Layout blocks from the Stitch draft: the record summary's breakdown and the project summary's scope row.
    await expect(page.getByTestId('dashboard-freshness-note')).toBeVisible()
    await expect(page.getByTestId('dashboard-record-total')).toBeVisible()
    await expect(page.getByTestId('dashboard-record-summary')).toContainText('Local-only events (outside the hash chain)')
    await expect(page.getByTestId('dashboard-scope-state')).toHaveText('Not set')
    await page.getByTestId('dashboard-open-activity').click()
    await expect(viewRoot()).toHaveAttribute('data-view', 'search')
  })

  test('scope, loot and bookmarks are reachable from the tab strip of their workspace', async () => {
    await page.locator('nav [data-view-btn="targets"]').first().click()
    for (const view of ['targets', 'scope']) {
      const tab = page.locator(`[data-view-btn="${view}"][role="tab"]`)
      await expect(tab, `${view} has no tab in the targets workspace`).toBeVisible()
      await tab.click()
      await expect(viewRoot()).toHaveAttribute('data-view', view)
    }

    await page.locator('nav [data-view-btn="screenshots"]').first().click()
    for (const view of ['screenshots', 'loot', 'bookmarks']) {
      const tab = page.locator(`[data-view-btn="${view}"][role="tab"]`)
      await expect(tab, `${view} has no tab in the evidence workspace`).toBeVisible()
      await tab.click()
      await expect(viewRoot()).toHaveAttribute('data-view', view)
    }
  })

  // Not fixed here: `transcript` renders the same rows as the Activity
  // workspace's 輸入／輸出 and AI 對話 tabs, so the answer may be an entrance or
  // it may be deleting the view. That decision is #563; until it is made, this
  // records the state instead of pretending the view is reachable.
  test.fixme('the transcript is reachable from a screen', async () => {
    await page.locator('nav [data-view-btn="search"]').first().click()
    await expect(page.getByTestId('workspace-open-transcript')).toBeVisible()
  })
})

// The "native desktop feel" work (PR #17) made the app's chrome behave like a
// desktop app rather than a web page: dragging across the sidebar, the status
// bar or the tab strip no longer paints everything blue, while content an
// operator needs to copy stays selectable.
//
// It shipped with the rule written down and never checked in a running app —
// the session that built it ended blocked on being able to launch one. This
// spec is the objective half of what that session listed as outstanding: the
// selection boundary is a computed style, so it can be measured rather than
// squinted at. (Native OS context menus, the other two items, are outside
// what Playwright can see and still need a human on each platform.)
//
// It also guards a boundary that moved afterwards. The export control (§10)
// now lives in the title bar, which is both `select-none` chrome and a
// `-webkit-app-region: drag` surface — and a button inside a drag region is
// decoration, because the OS takes the mousedown to move the window.


/** Resolved `user-select` for the first element matching a selector. */
async function userSelect(sel: string): Promise<string | null> {
  return page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    return getComputedStyle(el).userSelect || getComputedStyle(el).webkitUserSelect
  }, sel)
}

async function appRegion(sel: string): Promise<string | null> {
  return page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    return getComputedStyle(el).getPropertyValue('-webkit-app-region').trim()
  }, sel)
}

test.describe('chrome-selection', () => {
  test.beforeAll(async () => {
    await resetShared()
    await openTestProject(page, 'chrome-selection')
  })

  test.describe('chrome is not selectable, content is', () => {
    test('dragging across the sidebar does not select its labels', async () => {
      expect(await userSelect('[data-view-btn="search"]')).toBe('none')
    })

    test('the title bar does not select', async () => {
      // It is a drag surface. Text that highlights while you are moving the
      // window is the single most obvious "this is a web page" tell.
      const region = await appRegion('.h-10')
      expect(region).toBe('drag')
      expect(await userSelect('.h-10')).toBe('none')
    })

    test('the version string stays copyable, wherever it lives', async () => {
      // It used to sit in the title bar, where staying selectable was a
      // deliberate exception to the chrome rule. It moved to Settings ▸ About:
      // read once, pressed never, and it was taking a slot on the strip that
      // holds the evidence verbs. The guarantee did not move with it — a bug
      // report still starts with somebody copying this — so it is asserted
      // where the version now is.
      await openView(page, 'settings')
      await openSettingsPage(page, 'about')
      const sel = await page.evaluate(() => {
        const el = [...document.querySelectorAll('p')].find((p) => /v\d/.test(p.textContent ?? ''))
        if (!el) return null
        return { text: el.textContent ?? '', userSelect: getComputedStyle(el).userSelect }
      })
      expect(sel, 'no version on the About page').not.toBeNull()
      expect(sel!.text).toMatch(/v\d/)
      expect(sel!.userSelect).toBe('text')
      // Leave the app where this test found it: the cases below are about the
      // chrome, and they should not inherit a settings view from this one.
      await openView(page, 'dashboard')
    })

    test('the export control is reachable, not decoration behind a drag region', async () => {
      // §10 put one export control in the title bar. Inside a drag region the
      // OS takes the mousedown to move the window and the click never lands —
      // the button would look right and do nothing.
      // The control opens the export dialog (c130476c); it was a menu before.
      const btn = page.locator('[aria-haspopup="dialog"]').first()
      await expect(btn).toBeVisible()

      // `-webkit-app-region` does not inherit — its initial value is `none`, and
      // the drag surface is resolved by hit-testing the region boxes, not by
      // reading the computed style of the element under the cursor. So the
      // question is which region the button sits inside, which means walking up.
      const region = await btn.evaluate((el) => {
        for (let n: HTMLElement | null = el as HTMLElement; n; n = n.parentElement) {
          const v = getComputedStyle(n).getPropertyValue('-webkit-app-region').trim()
          if (v === 'drag' || v === 'no-drag') return v
        }
        return 'none'
      })
      expect(region).toBe('no-drag')

      await btn.click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
    })

    test('timeline content selects', async () => {
      await openView(page, 'timeline')
      expect(await userSelect('[data-testid="view-root"]')).toBe('text')
    })

    test('overlays outside the view root select too', async () => {
      // Toasts routinely carry the error message going into a report, and
      // confirm dialogs carry the exact path or session name. They render
      // outside the view root, so they needed the exception spelled out; the
      // failure mode is silent, because a dialog you cannot select looks
      // completely normal until you try.
      const containers = await page.evaluate(() =>
        [...document.querySelectorAll('.select-text')].length
      )
      expect(containers, 'no select-text opt-outs found at all').toBeGreaterThan(0)
    })
  })
})

test.describe('shared-frame', () => {
  test.beforeEach(async () => { await resetShared() })

  // Spec 069 US5 (shared frame): the title bar, sidebar and status bar are the
  // frame every page sits in. Their sizes are pinned here, in CSS px (offset*,
  // not getBoundingClientRect — the body renders at zoom 0.9, CLAUDE.md).
  //
  //   title bar   40  matches the Stitch prototypes (h-10)
  //   status bar  28  the prototype's h-7; was 32. Its controls keep WCAG 2.5.8's
  //                   24px floor, so 28 is the smallest the bar can be.
  //   sidebar    240  the prototype's w-60 (it was 150 until the layout was
  //                   asked to follow the prototype; colour and type stay the app's).
  test('shared frame keeps its sizes and the status bar controls keep a 24px target', async () => {
    test.setTimeout(60_000)
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'Frame')
    const m = await page.evaluate(() => {
      const bar = document.querySelector('[data-testid="status-bar"]') as HTMLElement
      const nav = document.querySelector('nav') as HTMLElement
      const title = nav.parentElement!.previousElementSibling as HTMLElement
      return {
        title: title.offsetHeight,
        status: bar.offsetHeight,
        sidebar: nav.offsetWidth,
        smallestControl: Math.min(...[...bar.querySelectorAll('button')].filter((b) => b.offsetWidth > 0).map((b) => b.offsetHeight))
      }
    })
    expect(m.title, 'title bar').toBe(40)
    expect(m.status, 'status bar').toBe(28)
    expect(m.sidebar, 'sidebar').toBe(240)
    expect(m.smallestControl, 'smallest status-bar control').toBeGreaterThanOrEqual(24)
    expect(m.smallestControl, 'and it fits inside the bar').toBeLessThanOrEqual(m.status)
  })

})

// Preload bridge slice for the recording endpoints. Full surface lives in
// src/renderer/src/env.d.ts — only the fields the tests actually call need
// names here.
interface RecordingBridge {
  get: () => Promise<boolean>
  toggle: () => Promise<boolean>
}

test.describe.serial('recording-flow: recording pause / resume', () => {
  test.beforeAll(async () => {
    await resetShared()
    // App.tsx's ⌘. shortcut early-returns when no project is active; open
    // one so the shortcut path fires.
    await openTestProject(page, 'e2e-recording')
  })

  test('recording.get is true on a fresh project', async () => {
    const initial = await page.evaluate(async () => {
      const api = (window as unknown as { redlog: { recording: RecordingBridge } }).redlog.recording
      return api.get()
    })
    expect(initial).toBe(true)

    // Status bar reflects the same state. The attribute is the recording
    // state and stays 'on' — but the LABEL is not "REC" here, and that is the
    // point of the test's own premise: on a fresh project nothing has been
    // captured yet, and the status bar now says so rather than claiming to be
    // recording something.
    //
    //   !recording                         → PAUSED
    //   recording && no event ever         → "Waiting for events…"
    //   recording && capture flowing       → REC
    //
    // "REC" on an engagement that has captured nothing is exactly the
    // reassuring lie the capture-health work exists to remove, so the
    // assertion follows the product rather than the other way round.
    const rec = page.locator('[data-testid="status-bar-recording"]')
    await expect(rec).toHaveAttribute('data-recording', 'on', { timeout: 2_000 })
    await expect(rec).toContainText('Waiting for events')
  })

  test('recording.toggle flips state and the status bar', async () => {
    const next = await page.evaluate(async () => {
      const api = (window as unknown as { redlog: { recording: RecordingBridge } }).redlog.recording
      return api.toggle()
    })
    expect(next).toBe(false)

    // recording.get must agree with toggle's return value.
    const confirmed = await page.evaluate(async () => {
      const api = (window as unknown as { redlog: { recording: RecordingBridge } }).redlog.recording
      return api.get()
    })
    expect(confirmed).toBe(false)

    // StatusBar subscribes to recording.onChange in its useEffect, so the
    // data-recording attribute + label flip on the next tick. No sleep —
    // let toHaveAttribute poll.
    const rec = page.locator('[data-testid="status-bar-recording"]')
    await expect(rec).toHaveAttribute('data-recording', 'off', { timeout: 2_000 })
    await expect(rec).toContainText('PAUSED')
  })

  test('⌘. (Ctrl+. on non-mac) flips recording back on', async () => {
    // App.tsx wires cmd+. to window.redlog.recording.toggle(). We're paused
    // from the previous test, so this press should flip to true.
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${mod}+.`)

    const rec = page.locator('[data-testid="status-bar-recording"]')
    await expect(rec).toHaveAttribute('data-recording', 'on', { timeout: 2_000 })
    // Same project, still nothing captured — so "Waiting for events…", not
    // "REC". What this test is about is the attribute flipping back to 'on';
    // see the first test for why the label reads the way it does.
    await expect(rec).toContainText('Waiting for events')

    // Double-check via IPC in case the DOM update raced somehow.
    const finalState = await page.evaluate(async () => {
      const api = (window as unknown as { redlog: { recording: RecordingBridge } }).redlog.recording
      return api.get()
    })
    expect(finalState).toBe(true)
  })
})

test.describe('http-verification-entry', () => {
  test.beforeEach(async () => { await resetShared() })

  test('HTTP settings exposes the real verification flow by keyboard at narrow width', async () => {
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await page.reload()
    await openTestProject(page, 'HTTP entry')
    await openView(page, 'settings')
    await openSettingsPage(page, 'browser')
    await resizeMainWindow(app, 900, 700)
    const entry = page.getByRole('button', { name: 'Verify HTTPS capture', exact: true })
    await expect(entry).toBeVisible()
    await entry.focus()
    await page.keyboard.press('Enter')
    await expect(entry).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('#http-verification-panel section')).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('http-verification-entry.png') })
    await entry.click()
    await expect(page.locator('#http-verification-panel')).toHaveCount(0)
  })

})

test.describe('project-rename', () => {
  test.beforeEach(async () => { await resetShared() })

  // Wiring of `project:rename` / `project:active` (R1b-4). ProjectRuntime's own
  // rules are unit-tested; what only the real app can show is that the rename
  // IPC handler tells the runtime. The title bar flips on a renderer event the
  // moment Settings commits, so it proves nothing about main — a reload does: it
  // re-reads `project.active()`, with the same project still open.
  //
  // Not covered here: a rename that arrives through an open that has already
  // ended. The UI has no path to it — the field only exists while a project is
  // open, and the picker rename runs with none — so the refusal stays a unit
  // test (test/project-runtime.test.ts).
  test('renaming the open project reaches the runtime, keeps its identity, and ends with it', async () => {
    try {
      await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
      const project = await openTestProject(page, 'rename-before')
      const titleBar = page.getByTestId('titlebar-leave-project')
      await expect(titleBar).toContainText('rename-before')
      expect(await page.evaluate(() => window.redlog.project.active())).toMatchObject({ id: project.id, name: 'rename-before' })

      const marker = (title: string) => page.evaluate((t) => window.redlog.marker.create({ title: t, notes: '', severity: 'info', category: 'custom' }), title)
      const before = await marker('before rename')
      expect(before?.engagementId).toBe(project.id)

      // Rename the way a user does: the project's Name field in Settings, committed on blur.
      await openView(page, 'settings')
      await openSettingsPage(page, 'scope')
      const nameField = page.getByLabel('Name', { exact: true }).first()
      await expect(nameField).toHaveValue('rename-before')
      await nameField.fill('rename-after')
      await nameField.blur()

      // main answers at once: no reload, no reopen.
      await expect.poll(() => page.evaluate(() => window.redlog.project.active().then(p => p?.name))).toBe('rename-after')
      await expect(titleBar).toContainText('rename-after')
      expect(await page.evaluate(() => window.redlog.project.active())).toMatchObject({ id: project.id })

      // A fresh renderer reads the name from main; the project was never reopened.
      await page.reload()
      await page.waitForSelector('[data-testid="view-root"]', { timeout: 10_000 })
      await expect(page.getByTestId('titlebar-leave-project')).toContainText('rename-after')
      await expect(page.getByTestId('titlebar-leave-project')).not.toContainText('rename-before')

      // Same open, same identity: a row written after the rename carries the engagement of the one before.
      const after = await marker('after rename')
      expect(after?.engagementId).toBe(project.id)
      expect(after?.engagementId).toBe(before?.engagementId)
      const [stored] = await page.evaluate((id) => window.redlog.events.getById([id]), after!.id)
      expect(stored.engagementId).toBe(project.id)

      // Closing ends the open: nothing is active, and the picker lists the new name.
      await page.getByTestId('titlebar-leave-project').click()
      await page.getByRole('button', { name: 'Stop recording and leave', exact: true }).click()
      await expect(page.getByTestId('project-picker')).toBeVisible()
      expect(await page.evaluate(() => window.redlog.project.active())).toBeNull()
      await expect(page.getByText('rename-after', { exact: true })).toBeVisible()
      await expect(page.getByText('rename-before', { exact: true })).toHaveCount(0)
    } catch (e) {
      console.log(`[DBG] ${(e as Error).message.split('\n').slice(0, 5).join(' | ')}`)
      throw e
    }
  })

})

test.describe.serial('scope-entry: scope entry and project identity', () => {
  test.beforeAll(async () => {
    await resetShared()
    // Back to the picker: earlier describes left a project open.
    await page.evaluate(() => window.redlog.project.close())
    await page.reload()
  })
  test('takes excludes in Settings and keeps the engagement ID read-only', async () => {
    // Spec 037 put excludes on the create card, they came off it, and #588
    // put the targets back (excludes folded under "Advanced scope"). This test
    // creates by name only and sets the exclude in Settings, which still owns
    // every scope setting; test/project-create-scope.test.tsx covers the card.
    await page.getByRole('button', { name: 'Create new project' }).click()
    await page.getByPlaceholder('e.g. Client-Pentest-Q3').fill('Scope Lab')
    await page.getByRole('button', { name: 'Create project', exact: true }).click()
    await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'dashboard')

    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${mod}+9`)
    await page.click('[data-settings-page="scope"]')
    // By its own placeholder: the page has three list fields and the labels
    // carry no `for`, so this is the one hook that names the exclude box
    // rather than the targets box above it.
    const excludeBox = page.getByPlaceholder('e.g. 10.0.0.1')
    await excludeBox.fill('127.0.0.1')
    // Commit with the button, not Enter. A validating list field takes a
    // paste, and the requirement splits it on newlines — so it is a textarea
    // where Enter stays a newline and ⌘/Ctrl+Enter or `+` commits.
    await excludeBox.locator('..').getByRole('button', { name: 'Add' }).click()

    const readConfig = (): Promise<{ engagement: { id: string }; scope: { excludeTargets: string[] } }> =>
      page.evaluate(() =>
        (window as unknown as { redlog: { config: { get: () => Promise<{ engagement: { id: string }; scope: { excludeTargets: string[] } }> } } }).redlog.config.get()
      )
    // Settings autosaves on a debounce, so the assertion polls rather than
    // reading once and racing it.
    await expect.poll(async () => (await readConfig()).scope.excludeTargets).toEqual(['127.0.0.1'])
    const config = await readConfig()

    // Already in Settings from the excludes above; move to the page that
    // shows the engagement identity — Scope since 0f79e841, where the project's
    // own settings now live. By its stable id, not its visible text: that
    // label has been reworded once already.
    await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'settings')
    await expect(page.getByTestId('settings-content')).toHaveAttribute('data-page', 'scope')
    const id = page.getByLabel('ID', { exact: true }).first()
    await expect(id).toHaveValue(config.engagement.id)
    await expect(id).toHaveAttribute('readonly', '')

    const savedId = await page.evaluate(async () => {
      const api = (window as unknown as { redlog: { config: { get: () => Promise<any>; save: (config: any) => Promise<boolean> } } }).redlog.config
      const current = await api.get()
      current.engagement.id = 'attempted-rewrite'
      await api.save(current)
      return (await api.get()).engagement.id as string
    })
    expect(savedId).toBe(config.engagement.id)
  })
})

test.describe('uiux-convergence (terminal font shortcuts)', () => {
  test.beforeEach(async () => { await resetShared() })

  test('terminal font shortcuts keep search input and Electron zoom independent', async () => {
    await page.evaluate(() => window.redlog.project.create('terminal-font-focus', { network: { offline: true } }))
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await page.reload()
    await openView(page, 'terminal')
    const terminal = page.locator('.xterm-helper-textarea').first()
    await expect(terminal).toBeAttached()
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    const window = await app.browserWindow(page)
    const zoom = await window.evaluate(w => w.webContents.getZoomFactor())
    await page.evaluate(() => localStorage.setItem('redlog-terminal-fontsize', '13'))
    await terminal.focus()
    await page.keyboard.press(`${mod}+=`)
    await expect.poll(() => page.evaluate(() => Number(localStorage.getItem('redlog-terminal-fontsize')))).toBe(14)
    await page.getByRole('button', { name: 'Search buffer', exact: true }).click()
    await page.getByPlaceholder('Search terminal buffer… Enter = next, Shift+Enter = previous', { exact: true }).focus()
    await page.keyboard.press(`${mod}+-`)
    expect(await page.evaluate(() => Number(localStorage.getItem('redlog-terminal-fontsize')))).toBe(14)
    expect(await window.evaluate(w => w.webContents.getZoomFactor())).toBe(zoom)
    await terminal.focus()
    await page.keyboard.press(`${mod}+0`)
    await expect.poll(() => page.evaluate(() => Number(localStorage.getItem('redlog-terminal-fontsize')))).toBe(13)
  })

})
