import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, mainWindowSize, resetSharedApp, openTestProject, openView, resizeMainWindow } from './helpers'

// The evidence readers (HTTP history, Search/Activity, Transcript, filtered
// export, scope) driven from seeded projects. One Electron launch for the file;
// each describe keeps its old spec's name, resets window size/zoom/localStorage
// and opens a project of its own. scope-recompute is last: it rewrites the
// project's scope, which nothing after it should inherit.

let app: ElectronApplication
let page: Page
let tmpHome: string
let initialSize: [number, number]

const resetShared = (): Promise<void> => resetSharedApp(app, page, initialSize)
interface T { spawn: (i: string, c: number, r: number) => Promise<unknown>; write: (i: string, d: string) => void; kill: (i: string) => void }

test.beforeAll(async () => {
  test.setTimeout(60_000)
  const launched = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP)
  app = launched.app
  page = launched.page
  tmpHome = launched.tmpHome
  initialSize = await mainWindowSize(app)
})

test.afterAll(async () => { if (app) await app.close() })

// HTTP History is a flat HTTP log — Burp Proxy > HTTP history — one row per
// flow, newest first, time in the leading column. It only presents the HTTP
// record; grouping traffic under the command that produced it is the Timeline's
// job, so the panel carries no activity/point-span grouping of its own.

let base = ''
let token = ''

test.describe.serial('http-history-view: HTTP history is a flat per-request log', () => {
  test.beforeAll(async () => {
    await resetShared()
    await openTestProject(page, 'http-history')
    await page.waitForTimeout(1500)
    base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()

    const post = (data: Record<string, unknown>): Promise<Response> =>
      fetch(`${base}/api/events/seed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type: 'scanner', data })
      })
    // A handful of flows against one host, then one lone request to another —
    // seeded last, so it is the newest row and lands at the top of the log.
    for (let i = 0; i < 8; i++) {
      const flow = `req-${i}`
      await post({ subtype: 'http_request_start', flow_id: flow, method: 'GET',
        url: `http://target.example/admin${i}`, host: 'target.example' })
      await post({ subtype: 'http_response', flow_id: flow, status: i % 5 === 0 ? 200 : 404,
        url: `http://target.example/admin${i}`, host: 'target.example', duration_ms: 12 })
    }
    await post({ subtype: 'http_request_start', flow_id: 'lone', method: 'POST',
      url: 'http://other.example/login', host: 'other.example' })
    await post({ subtype: 'http_response', flow_id: 'lone', status: 302,
      url: 'http://other.example/login', host: 'other.example', duration_ms: 30 })
    await page.waitForTimeout(800)
    await openView(page, 'http_history')
    await page.waitForTimeout(800)
  })


  test('renders one flat table, not grouped activity rows', async () => {
    await expect(page.locator('table')).toBeVisible()
    // The removed grouping left no trace: no activity rows, no view toggle.
    await expect(page.locator('[data-testid="http-activity-row"]')).toHaveCount(0)
    await expect(page.locator('[data-http-view]')).toHaveCount(0)
  })

  test('time is the leading column', async () => {
    const firstHeader = page.locator('table thead th').first()
    await expect(firstHeader).toContainText('When')
  })

  test('every request is its own row', async () => {
    // The lone POST was seeded last, so it is the newest row at the top.
    const row = page.locator('tr', { hasText: '/login' }).first()
    await expect(row).toBeVisible()
    await expect(row).toContainText('POST')
    await expect(row).toContainText('302')
  })

  test('a row opens the request/response detail', async () => {
    await page.locator('tr', { hasText: '/login' }).first().click()
    await expect(page.locator('text=Request').first()).toBeVisible()
    await expect(page.locator('text=Response').first()).toBeVisible()
  })
})

test.describe.serial('personal-traffic-visibility: personal traffic visibility', () => {
  test.beforeAll(async () => {
    await resetShared()
    await openTestProject(page, 'e2e-personal-visibility')
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()
    for (const target of ['127.0.0.1', '10.10.10.5']) {
      const response = await fetch(`${base}/api/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type: 'marker', target_id: target, data: { title: `traffic-canary ${target}` } })
      })
      expect(response.status).toBe(201)
    }
    await openView(page, 'search')
    await page.locator('#reading-tab-events').click()
  })

  test('hides personal targets by default and reveals them with one filter control', async () => {
    await page.getByTestId('search-input').fill('traffic-canary')
    await expect(page.getByText('→ 10.10.10.5')).toBeVisible()
    await expect(page.getByText('→ 127.0.0.1')).toHaveCount(0)

    const visibility = page.getByRole('button', { name: 'Non-work hidden' })
    await expect(visibility).toBeVisible()
    await visibility.click()

    await expect(page.getByText('→ 127.0.0.1')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Non-work visible' })).toBeVisible()
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+k`)
    await page.getByRole('dialog').getByRole('combobox').fill('Loot')
    await page.getByRole('option').filter({ hasText: 'Loot' }).click()
    await expect(page.locator('[data-view="loot"]')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Non-work visible' })).toBeVisible()
    await page.getByRole('button', { name: 'Non-work visible' }).click()
    await expect(page.getByRole('button', { name: 'Non-work hidden' })).toBeVisible()
  })
})

test.describe('transcript-view', () => {
  test.beforeEach(async () => { await resetShared() })

  // v0.11.2 (design note T5). The Timeline answers "when did this happen and
  // what did it cause"; the transcript answers "what did I type and what came
  // back" — the question an operator asks when writing an engagement up, which
  // previously meant clicking dots one at a time.
  //
  // What is asserted here is the folding: a tool_call and its tool_result are
  // ONE exchange, not two rows, and likewise an HTTP request and its response.
  // Getting that wrong is what makes a transcript unreadable.
  test('folds request/response pairs into single exchanges', async () => {
    test.setTimeout(180_000)
    await openTestProject(page, 'tr')
    await page.waitForTimeout(1500)
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
    const post = (agent_type: string, data: Record<string, unknown>) => fetch(`${base}/api/events`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ agent_type, data }) })

    // A shell command with no captured output (external shell)
    await post('shell', { subtype: 'command_end', command: 'nmap -sV 10.0.0.5', exit_code: 0, duration_sec: 12 })
    // An HTTP exchange with a response body
    await post('scanner', { subtype: 'http_request_start', flow_id: 'f1', method: 'GET', url: 'https://t.example/api/users', params: { query: { page: '1' } } })
    await post('scanner', { subtype: 'http_response', flow_id: 'f1', method: 'GET', url: 'https://t.example/api/users', status: 200, content_length: 42, duration_ms: 87, response_preview: '{"users":[{"id":1,"name":"admin"}]}' })
    // An agent tool call + result
    await post('agent', { subtype: 'tool_call', agent: 'claude-code', session_id: 'ai-session', tool_name: 'Bash', tool_use_id: 'tu1', tool_input: { command: 'id' } })
    await post('agent', { subtype: 'tool_result', agent: 'claude-code', session_id: 'ai-session', tool_use_id: 'tu1', output: 'uid=0(root) gid=0(root)' })
    await post('marker', { title: 'found admin panel', severity: 'important' })
    await page.waitForTimeout(1500)

    // Exercise the new projection through the shipped preload/IPC, using the
    // same real ingest fixture and Electron session as the reading journey.
    const activity = await page.evaluate(async () => {
      const config = await window.redlog.config.get()
      const request = {
        projectId: config.engagement.id,
        parsed: { text: 'root', tokens: [], conditions: [{ field: 'tool' as const, value: 'tu1' }, { field: 'session' as const, value: 'ai-session' }] }
      }
      const page = await window.redlog.events.activityPage(request)
      const item = page.items[0]
      const members = await window.redlog.events.activityMembers({ ...request, snapshot: page.snapshot, ref: item })
      let foreignRejected = false
      try { await window.redlog.events.activityPage({ ...request, projectId: 'foreign-project' }) }
      catch { foreignRejected = true }
      return { item, totalGroups: page.totalGroups, totalMatches: page.totalMatches, members, foreignRejected }
    })
    expect(activity).toMatchObject({ totalGroups: 1, totalMatches: 1, foreignRejected: true,
      item: { kind: 'tool', state: 'paired', action: 'command', provider: 'claude-code', sourceCount: 2, contextCount: 1 },
      members: { sourceCount: 2, matchedCount: 1, hasMore: false } })
    expect(activity.item.id).toMatch(/^act1:[a-f0-9]{64}$/)
    expect(activity.members.items.map(m => [m.event.data.subtype, m.matched])).toEqual([['tool_call', false], ['tool_result', true]])

    await resizeMainWindow(app, 1500, 1000)
    await openView(page, 'transcript')
    await page.waitForTimeout(1500)
    await expect(page.getByTestId('transcript-completeness')).toContainText('Loaded set complete')

    // Six events in, four exchanges out: the two pairs each collapse to one.
    const blocks = await page.evaluate(() =>
      document.querySelectorAll('div.rounded.border.border-redlog-border\\/70').length)
    expect(blocks, 'a call and its result must render as one exchange').toBe(4)

    // Collapsed is the default as of fc30071 — a transcript of a real engagement
    // is unreadable if every command dumps its full output inline. The inputs
    // are what you scan; the outputs are what you open.
    const collapsed = await page.evaluate(() => document.body.innerText)
    expect(collapsed, 'the command itself').toMatch(/nmap -sV 10\.0\.0\.5/)
    expect(collapsed, 'the request line').toMatch(/GET https:\/\/t\.example/)
    expect(collapsed, 'output stays folded until asked for').not.toMatch(/"name":"admin"/)

    // Expand every exchange that has something to show. This assertion used to
    // pass without the click, because output rendered unconditionally; fc30071
    // changed that deliberately and this spec was not updated with it, so it has
    // been failing on main ever since.
    const collapsedToggles = page.locator('[data-testid="transcript-toggle"][data-expanded="false"]')
    const n = await collapsedToggles.count()
    expect(n, 'three of the four exchanges carry output').toBe(3)
    for (let i = 0; i < n; i++) await collapsedToggles.first().click()
    await expect(page.locator('[data-testid="transcript-toggle"][data-expanded="false"]')).toHaveCount(0)

    const txt = await page.evaluate(() => document.body.innerText)
    expect(txt, 'the response body, which had no UI at all before this').toMatch(/"name":"admin"/)
    expect(txt, 'a tool result shown under the call that produced it').toMatch(/uid=0\(root\)/)
    // Absence stated, not implied — an external shell records the command only,
    // and that has to look different from a command that printed nothing.
    expect(txt, 'uncaptured output must say so').toMatch(/output not captured/)
  })

  // A batch arriving while the transcript is open used to clear it and reload
  // from the first page: it blanked, and the reader lost their place. Measured
  // in the real layout, because the unit test can only give rows fake heights.
  test('takes new rows without blanking or moving the row being read', async () => {
    test.setTimeout(180_000)
    try {
      await openTestProject(page, 'trl')
      await page.waitForTimeout(1500)
      const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
      const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
      const say = (text: string) => fetch(`${base}/api/events`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type: 'agent', data: { subtype: 'assistant_message', agent: 'claude-code', session_id: 's1', full: text } }) })

      for (let i = 0; i < 40; i++) await say(`seed message ${i}`)
      await resizeMainWindow(app, 1500, 1000)
      await openView(page, 'transcript')
      const rows = page.locator('[data-block-id]')
      await expect(rows).toHaveCount(40)

      // Read from the middle; note which row is at the top and where.
      const before = await page.evaluate(() => {
        const body = document.querySelector('[data-testid="transcript-body"]') as HTMLElement
        body.scrollTop = 600
        body.dispatchEvent(new Event('scroll'))
        const el = [...body.querySelectorAll<HTMLElement>('[data-block-id]')].find((r) => r.offsetTop + r.offsetHeight > body.scrollTop)!
        // Count every frame with no rows, from here until the end of the test.
        ;(window as unknown as { __blank: number }).__blank = 0
        new MutationObserver(() => {
          if (body.querySelectorAll('[data-block-id]').length === 0) (window as unknown as { __blank: number }).__blank++
        }).observe(body, { childList: true, subtree: true })
        return { id: el.dataset.blockId!, offset: el.offsetTop - body.scrollTop }
      })

      for (let i = 0; i < 3; i++) await say(`live message ${i}`)
      await expect(rows).toHaveCount(43)
      await expect(page.getByTestId('transcript-unseen')).toContainText('3 new')

      const after = await page.evaluate((id) => {
        const body = document.querySelector('[data-testid="transcript-body"]') as HTMLElement
        const el = [...body.querySelectorAll<HTMLElement>('[data-block-id]')].find((r) => r.dataset.blockId === id)!
        return { offset: el.offsetTop - body.scrollTop, blank: (window as unknown as { __blank: number }).__blank }
      }, before.id)
      expect(after.blank, 'the list must never empty while it refreshes').toBe(0)
      expect(Math.abs(after.offset - before.offset), 'the row being read stays where it was').toBeLessThanOrEqual(1)

      await page.getByTestId('transcript-unseen').click()
      await expect(page.getByTestId('transcript-unseen')).toHaveCount(0)
      expect(await page.evaluate(() => (document.querySelector('[data-testid="transcript-body"]') as HTMLElement).scrollTop)).toBe(0)
    } catch (e) {
      console.log(`[DBG] ${(e as Error).message.split('\n').slice(0, 5).join(' | ')}`)
      throw e
    }
  })

})

test.describe('search-query-contract', () => {
  test.beforeEach(async () => { await resetShared() })

  test('Search executes and explains the shared event query contract', async () => {
    test.setTimeout(180_000)
    await openTestProject(page, 'search-contract')
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
    await fetch(`${base}/api/events`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ agent_type: 'agent', data: {
        subtype: 'assistant_message', agent: 'codex', session_id: 'session-e2e', full: 'contract evidence'
      } })
    })

    await openView(page, 'search')
    await page.locator('#reading-tab-events').click()
    await page.getByTestId('search-input').fill('session:session-e2e contract')
    await expect(page.getByTestId('search-query-parse')).toContainText('session:session-e2e')
    await expect(page.getByTestId('search-results')).toHaveAttribute('aria-busy','false')
    await expect(page.getByTestId('search-results').getByRole('option')).toHaveCount(1)
    await expect(page.getByTestId('search-results').getByRole('option')).toContainText('contract evidence')
  })

})

test.describe('activity-return-state', () => {
  test.beforeEach(async () => { await resetShared() })

  // #589: leaving the activity list for the timeline and coming back must put the
  // operator where they were — query, filters, which row was open and how far
  // down the list they had scrolled — not at the top of a fresh list.
  test('returning from the timeline keeps the activity list where it was', async () => {
    test.setTimeout(120_000)
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'return-state')
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()
    for (let i = 0; i < 80; i++) {
      const r = await fetch(`${base}/api/events/seed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type: 'shell', data: { subtype: 'command_start', command: `echo marker-${String(i).padStart(3, '0')}` } })
      })
      expect(r.ok).toBe(true)
    }

    await openView(page, 'search')
    await page.getByTestId('search-input').fill('marker')
    await expect(page.getByTestId('activity-row').nth(40)).toBeAttached()
    const results = page.getByTestId('search-results')
    await page.getByTestId('activity-row').first().click()
    await expect(page.getByTestId('activity-row').first()).toHaveAttribute('aria-expanded', 'true')
    await results.evaluate((el) => { el.scrollTop = 900 })
    const before = await results.evaluate((el) => el.scrollTop)
    expect(before).toBeGreaterThan(300)

    await page.getByTestId('workspace-open-timeline').click()
    await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'timeline')
    await page.getByRole('button', { name: /^← / }).click()
    await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'search')

    await expect(page.getByTestId('search-input')).toHaveValue('marker')
    await expect(page.getByTestId('activity-row').first()).toHaveAttribute('aria-expanded', 'true')
    const after = await results.evaluate((el) => el.scrollTop)
    expect(Math.abs(after - before), `scrollTop ${before} → ${after}`).toBeLessThan(4)
  })

  async function seedShell(base: string, token: string, prefix: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      const r = await fetch(`${base}/api/events/seed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type: 'shell', data: { subtype: 'command_start', command: `echo ${prefix}-${i}` } })
      })
      expect(r.ok).toBe(true)
    }
  }

  // The open Reader is part of "where the operator was": locating from it and
  // coming back must reopen it on the same query with the same row expanded, and
  // the timeline must have selected the event the Reader was showing.
  test('locating from the Reader and returning restores the Reader, query and open row', async () => {
    test.setTimeout(120_000)
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'reader-return')
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()
    await seedShell(base, token, 'marker', 12)

    await openView(page, 'search')
    await page.getByTestId('search-input').fill('marker')
    await page.getByTestId('activity-row').nth(3).click()
    await page.getByTestId('activity-read').first().click()
    await expect(page.getByTestId('activity-reader')).toBeVisible()

    await page.getByTestId('reader-locate').click()
    await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'timeline')
    await expect(page.getByTestId('timeline-detail-panel')).toHaveCount(1)
    const selected = await page.evaluate(() => localStorage.getItem('redlog-timeline-focus-event'))
    expect(selected, 'the timeline selected a concrete event').toBeTruthy()

    await page.getByRole('button', { name: /^← / }).click()
    await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'search')
    await expect(page.getByTestId('activity-reader')).toBeVisible()
    await expect(page.getByTestId('search-input')).toHaveValue('marker')
    await expect(page.locator('[data-testid="activity-row"][aria-expanded="true"]')).toHaveCount(1)
    expect(await page.evaluate(() => localStorage.getItem('redlog-timeline-focus-event'))).toBe(selected)
  })

  // The selected-event id is one global key, so what protects project B from
  // project A's selection is that the id simply matches nothing there. Pin that:
  // after switching, B's timeline opens no detail pane, the Activity page starts
  // with no query and no Reader.
  test('switching project does not carry the selected event or the reading context over', async () => {
    test.setTimeout(120_000)
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'switch-a')
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()
    await seedShell(base, token, 'marker', 8)

    await openView(page, 'search')
    await page.getByTestId('search-input').fill('marker')
    await page.getByTestId('activity-row').first().click()
    await page.getByTestId('activity-read').first().click()
    await page.getByTestId('reader-locate').click()
    await expect(page.getByTestId('timeline-detail-panel')).toHaveCount(1)

    await page.evaluate(async () => {
      const bridge = (window as unknown as { redlog: { project: { create: (n: string) => Promise<{ id: string }>; open: (id: string) => Promise<unknown> } } }).redlog
      const created = await bridge.project.create('switch-b')
      await bridge.project.open(created.id)
    })
    await page.reload()
    await page.waitForSelector('[data-testid="view-root"]')
    // The API's port and token belong to the open project; read them again.
    const baseB = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
    const tokenB = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()
    await seedShell(baseB, tokenB, 'other', 5)

    await openView(page, 'timeline')
    await expect(page.getByTestId('timeline-range-status')).toBeVisible()
    await expect(page.getByTestId('timeline-detail-panel')).toHaveCount(0)
    await openView(page, 'search')
    await expect(page.getByTestId('activity-reader')).toHaveCount(0)
    await expect(page.getByTestId('search-input')).toHaveValue('')
    // B really has events (this is not an empty-project pass).
    await page.getByTestId('search-input').fill('other')
    await expect(page.getByTestId('activity-row').first()).toBeVisible()
  })

  // Stitch 06: the route runs both ways. Opening a Timeline event in the activity
  // log must leave a way back, and that way back must land on the same event —
  // the Timeline is not kept mounted, so it is re-focused, not merely re-shown.
  test('opening a timeline event in the activity log returns to the same event', async () => {
    test.setTimeout(120_000)
    try {
      await page.waitForLoadState('domcontentloaded')
      await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
      await openTestProject(page, 'timeline-to-activity')
      const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
      const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()
      await seedShell(base, token, 'roundtrip', 6)

      await openView(page, 'timeline')
      await page.getByRole('button', { name: /roundtrip-3/ }).first().click()
      await expect(page.getByTestId('timeline-detail-panel')).toContainText('roundtrip-3')
      const selected = await page.evaluate(() => localStorage.getItem('redlog-timeline-focus-event'))
      expect(selected, 'the timeline selected a concrete event').toBeTruthy()

      await page.getByTestId('detail-open-activity').click()
      await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'search')
      await expect(page.getByTestId('search-input')).toHaveValue(`event:${selected}`)
      await expect(page.getByTestId('activity-row').first()).toBeVisible()

      await page.getByTestId('activity-return').getByRole('button').click()
      await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'timeline')
      await expect(page.getByTestId('timeline-detail-panel')).toContainText('roundtrip-3')
      expect(await page.evaluate(() => localStorage.getItem('redlog-timeline-focus-event'))).toBe(selected)
      await expect(page.getByTestId('activity-return')).toHaveCount(0)
    } catch (e) {
      console.log(`[DBG] ${(e as Error).message.split('\n').slice(0, 5).join(' | ')}`)
      throw e
    }
  })

})

test.describe('filtered-export', () => {
  test.beforeEach(async () => { await resetShared() })

  for (const locale of ['en', 'zh-TW']) {
   test(`filtered export is explicit, frozen and readable in ${locale}`, async () => {
     await page.evaluate(l => localStorage.setItem('redlog-locale',l), locale)
     await openTestProject(page,'filtered-export')
     const base=`http://127.0.0.1:${readFileSync(join(tmpHome,'.redlog','api-port'),'utf8').trim()}`
     const token=readFileSync(join(tmpHome,'.redlog','api-token'),'utf8').trim()
     const matching = ['needle evidence', ...Array.from({ length: 105 }, (_, i) => `needle paginated ${i}`)]
     for (const command of [...matching, 'other evidence']) {
      const result=await fetch(base+'/api/events/seed',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({agent_type:'shell',target_id:'example.test',data:{subtype:'command_end',command,exit_code:0}})})
      expect(result.ok).toBe(true)
     }
     await openView(page,'search')
      await page.locator('#reading-tab-events').click()
     await page.getByTestId('search-input').fill('needle')
     await expect(page.getByRole('option').filter({hasText:'needle paginated 104'}).first()).toBeVisible()
     const win=await app.browserWindow(page); await win.evaluate(w=>w.setSize(800,850))
     const exportLabel=locale==='en'?'Export':'匯出'
     await page.getByLabel(exportLabel,{exact:true}).click()
     await expect(page.getByTestId('export-preview-subset')).toContainText('needle')
     // Search has a 100-row page. Export must include all 106 matches without
     // requiring Load more, and switching format must retain that query.
     const formatLabel=locale==='en'?'Export format':'匯出格式'
     await page.getByLabel(formatLabel,{exact:true}).selectOption('other')
     const otherLabel=locale==='en'?'Other formats':'其他格式'
     await page.getByLabel(otherLabel,{exact:true}).selectOption('ndjson')
     await expect(page.getByTestId('export-preview-subset')).toContainText('needle')
     await page.getByLabel(otherLabel,{exact:true}).selectOption('json')
     await expect(page.getByTestId('export-projection-notice')).toBeVisible()
     await expect(page.getByTestId('export-confirm')).toBeEnabled()
     // A matching event received after the operator saw the preview must not
     // enter the confirmed artifact, even though it appears in the live search.
     const later=await fetch(base+'/api/events/seed',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({agent_type:'shell',target_id:'example.test',data:{subtype:'command_end',command:'needle after preview',exit_code:0}})})
     expect(later.ok).toBe(true)
     const dialog=page.getByTestId('export-dialog')
     expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
     await page.getByTestId('export-confirm').focus(); await page.keyboard.press('Enter')
     await expect(page.getByTestId('export-completed')).toBeVisible()
     await page.getByRole('button',{name:locale==='en'?'Close':'關閉',exact:true}).last().click()
     const active=await page.evaluate(async () => {
      const current=await window.redlog.project.active()
      return (await window.redlog.project.list()).find(project => project.id===current?.id)!
     })
     const exportDir=join(active.path,'exports')
     const artifact=readdirSync(exportDir).find(name => name.endsWith('.json') && !name.endsWith('.manifest.json'))!
     const rows=JSON.parse(readFileSync(join(exportDir,artifact),'utf8')).events
     expect(rows.map((row: { data: { command: string } })=>row.data.command).sort()).toEqual([...matching].sort())
     // A legitimate empty selection still previews; it cannot be confirmed.
     await page.getByTestId('search-input').fill('never-recorded-token')
     await page.getByLabel(exportLabel,{exact:true}).click()
     await expect(page.getByTestId('export-confirm')).toBeDisabled()
     await page.keyboard.press('Escape'); await page.keyboard.press('Escape')
     await page.getByTestId('search-input').fill('session:')
     await page.getByLabel(exportLabel,{exact:true}).click()
     await expect(page.getByText('Invalid export query',{exact:false})).toBeVisible()
   })
  }
})

test.describe('uiux-convergence (HTTP scope, violation details)', () => {
  test.beforeEach(async () => { await resetShared() })

  test('HTTP scope distinguishes unset, outside and unreadable policy at desktop and minimum window', async () => {
    await page.evaluate(() => window.redlog.project.create('http-scope-display', { network: { offline: true } }))
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await page.reload()
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()
    const response = await fetch(`${base}/api/events/seed`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ agent_type: 'scanner', data: { subtype: 'http_request_start', flow_id: 'scope-proof', url: 'https://outside.test/path', host: 'outside.test', method: 'GET' } }) })
    expect(response.ok).toBe(true)
    await openView(page, 'http_history')
    await expect(page.getByTestId('http-scope-state')).toHaveAttribute('data-scope', 'no-scope')
    await page.evaluate(async () => { const c = await window.redlog.config.get(); await window.redlog.config.save({ ...c!, scope: { ...c!.scope, targets: ['inside.test'] } }) })
    await expect(page.getByTestId('http-scope-state')).toHaveAttribute('data-scope', 'out-of-scope')
    await resizeMainWindow(app, 800, 500)
    await expect(page.getByTestId('http-scope-state')).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('http-scope-minimum.png') })
    await page.evaluate(async () => { const c = await window.redlog.config.get(); await window.redlog.config.save({ ...c!, scope: { ...c!.scope, scopeFile: '/missing-scope-fixture.txt' } }) })
    await expect(page.getByTestId('http-scope-state')).toHaveAttribute('data-scope', 'unknown')
  })

  test('violation details resolve the full command and carry an uncommitted candidate to Scope settings', async () => {
    await page.evaluate(() => window.redlog.project.create('scope-detail-candidate', { network: { offline: true }, scope: { targets: ['inside.test'], excludeTargets: ['outside.test'], warnOnViolation: true } }))
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await page.reload()
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()
    const command = 'curl https://outside.test/' + 'original-argument-'.repeat(30)
    const posted = await fetch(`${base}/api/events/seed`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ agent_type: 'shell', data: { subtype: 'command_start', detectedTarget: 'outside.test', command } }) })
    expect(posted.ok).toBe(true)
    await openView(page, 'scope')
    await page.getByTestId('scope-judged-live').first().click()
    const detail = page.getByTestId('scope-observation-detail')
    await expect(detail.locator('pre')).toHaveText(command)
    // Stitch 02: reason and rule are separate cells.
    const facts = detail.getByTestId('scope-observation-facts')
    await expect(facts).toContainText('Matched exclusion rule')
    await expect(facts).toContainText('outside.test')
    await detail.getByRole('button', { name: 'Edit related scope rules' }).click()
    await expect(page.getByRole('textbox', { name: 'Targets (IPs, CIDRs, *.domain)', exact: true })).toHaveValue('outside.test')
    const saved = await page.evaluate(() => window.redlog.config.get())
    expect(saved?.scope.targets).toEqual(['inside.test'])
    await page.screenshot({ path: test.info().outputPath('scope-candidate-uncommitted.png') })
  })

})

// Design turn 8a, end to end. The unit and DB suites prove the decision and the
// writes; what only the real app can show is that a save actually triggers the
// run through the debounce, that the page reflects it, and that a retroactive
// judgement is visibly different from one made at the time — which is the whole
// point of the feature and the one thing a wrong answer would quietly hide.


interface ScopeBridge {
  config: {
    get: () => Promise<Record<string, unknown>>
    save: (c: Record<string, unknown>) => Promise<boolean>
  }
  scope: {
    getObservations: () => Promise<{ rows: Array<{ judged: string; cleared: boolean; target: string }>; truncated: boolean }>
    getLastRecompute: () => Promise<Record<string, unknown> | null>
  }
  chain: { verify: () => Promise<{ ok: boolean }> }
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

// The AI reading, walked as an operator would (Stitch 06 / spec 069 audit):
// pick a source session, search inside it, open one turn on the Timeline and
// come back to the same session, query and turn. Two sessions are seeded so
// "picked one session" is visible as the other one's absence.
test.describe('ai-transcript-journey', () => {
  test.beforeEach(async () => { await resetShared() })

  test('session pick, search, show on the Timeline and back keep the AI reading', async () => {
    test.setTimeout(180_000)
    try {
      await openTestProject(page, 'ai-journey')
      const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
      const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
      const post = async (data: Record<string, unknown>): Promise<void> => {
        const r = await fetch(`${base}/api/events`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ agent_type: 'agent', data: { agent: 'claude-code', ...data } }) })
        expect(r.ok).toBe(true)
      }
      await post({ subtype: 'user_message', session_id: 'alpha-session', full: 'kerberoast the alpha domain' })
      await post({ subtype: 'tool_call', session_id: 'alpha-session', tool_name: 'Bash', tool_use_id: 'tu-alpha', tool_input: { command: 'id' } })
      await post({ subtype: 'tool_result', session_id: 'alpha-session', tool_use_id: 'tu-alpha', output: 'uid=0(root) gid=0(root)' })
      await post({ subtype: 'assistant_message', session_id: 'alpha-session', full: 'alpha reply about tickets' })
      await post({ subtype: 'assistant_message', session_id: 'beta-session', full: 'beta unrelated reply' })

      await openView(page, 'search')
      await page.locator('#reading-tab-ai').click()
      const panel = page.locator('#reading-panel-ai')
      await page.getByRole('combobox', { name: 'AI source' }).selectOption('claude-code')
      const session = page.getByRole('combobox', { name: 'Source session' })
      await expect(session.locator('option', { hasText: 'alpha-session' })).toHaveCount(1)
      const alpha = await session.locator('option', { hasText: 'alpha-session' }).getAttribute('value')
      await session.selectOption(alpha!)

      // One session: its turns are here, the other session's are not.
      await expect(panel).toContainText('alpha reply about tickets')
      await expect(panel).not.toContainText('beta unrelated reply')

      // Search inside the picked session.
      await page.getByTestId('search-input').fill('kerberoast')
      await expect(panel).toContainText('kerberoast the alpha domain')
      await expect(panel).not.toContainText('alpha reply about tickets')

      // Show that turn on the Timeline, then come back.
      await panel.getByTestId('transcript-open-timeline').first().click()
      await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'timeline')
      await expect(page.getByTestId('timeline-detail-panel')).toContainText('kerberoast')
      await page.getByTestId('timeline-return').getByRole('button').click()

      await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'search')
      await expect(page.locator('#reading-tab-ai')).toHaveAttribute('aria-selected', 'true')
      await expect(session).toHaveValue(alpha!)
      await expect(page.getByTestId('search-input')).toHaveValue('kerberoast')
      await expect(panel).toContainText('kerberoast the alpha domain')
    } catch (e) {
      console.log(`[DBG] ${(e as Error).message.split('\n').slice(0, 5).join(' | ')}`)
      throw e
    }
  })
})

test.describe.serial('scope-recompute: recomputing scope after the boundary moves', () => {
  test.beforeAll(async () => {
    await resetShared()
    await openTestProject(page, 'scope-recompute')
    await page.waitForTimeout(1500)

    // Work done BEFORE any scope existed. That is the situation the feature is
    // about: the operator did not know yet.
    await post('shell', { subtype: 'command_start', detectedTarget: 'evil.example', command: 'curl https://evil.example/a' })
    await post('shell', { subtype: 'command_start', detectedTarget: 'evil.example', command: 'curl https://evil.example/b' })
    await post('shell', { subtype: 'command_start', detectedTarget: 'www.target.com', command: 'curl https://www.target.com/' })
    await post('dns', { subtype: 'dns_query', query_name: 'evil.example.', query_type: 'A' })
    await page.waitForTimeout(1500)
    await resizeMainWindow(app, 1500, 1000)
  })


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
      (window as unknown as { redlog: ScopeBridge }).redlog.chain.verify())
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
    const { rows } = await page.evaluate(() =>
      (window as unknown as { redlog: ScopeBridge }).redlog.scope.getObservations())
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
