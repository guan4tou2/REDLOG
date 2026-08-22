import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, openTestProject } from './helpers'

// v0.9.5 pause semantics, end to end through the HTTP surface the shell hook
// and mitmproxy addon actually use.

let app: ElectronApplication
let page: Page
let tmpHome = ''
let base = ''
let token = ''

const post = (agent_type: string, data: Record<string, unknown>): Promise<Response> =>
  fetch(`${base}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ agent_type, data })
  })

const count = async (): Promise<number> =>
  fetch(`${base}/api/events?limit=1000`, { headers: { authorization: `Bearer ${token}` } })
    .then((r) => r.json())
    .then((j: { events: unknown[] }) => j.events.length)

const setRecording = async (on: boolean): Promise<void> => {
  await page.evaluate(async (want) => {
    const api = (window as unknown as { redlog: { recording: { get: () => Promise<boolean>; toggle: () => Promise<boolean> } } }).redlog.recording
    if ((await api.get()) !== want) await api.toggle()
  }, on)
  await page.waitForTimeout(200)
}

test.describe.serial('recording pause semantics', () => {
  test.beforeAll(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'redlog-pause-'))
    app = await electron.launch({
      args: [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' }
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await openTestProject(page, 'pause-semantics')
    await page.waitForTimeout(1500)
    base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
  })

  test.afterAll(async () => { if (app) await app.close() })

  test('a paused POST answers 200 so the shell hook does not spool it', async () => {
    await setRecording(false)
    const res = await post('shell', { subtype: 'command_end', command: 'secret-while-paused', exit_code: 0 })
    // `curl -sf` in shell-preexec-hook.sh treats any non-2xx as failure and
    // writes the payload to ~/.redlog/pending/, which RedLog replays on the
    // next project open — the paused command would reach the chain anyway.
    expect(res.status, 'non-2xx would make the hook spool and replay this later').toBe(200)
    const body = await res.json() as { recording?: boolean; skipped?: string }
    expect(body.recording).toBe(false)
    expect(body.skipped).toBeTruthy()
  })

  test('nothing from the paused window reached the DB', async () => {
    const all = await fetch(`${base}/api/events?limit=1000`, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => r.json()) as { events: Array<{ data?: Record<string, unknown> }> }
    const leaked = all.events.filter((e) => JSON.stringify(e.data ?? {}).includes('secret-while-paused'))
    expect(leaked, 'the paused command must not appear anywhere').toEqual([])
    expect(existsSync(join(tmpHome, '.redlog', 'pending')) ? readdirSync(join(tmpHome, '.redlog', 'pending')) : [])
      .toEqual([])
  })

  test('no derived events leak the paused content', async () => {
    const before = await count()
    // A command whose target would normally raise scope_violation + loot.
    await post('shell', {
      subtype: 'command_end',
      command: 'curl -H "Authorization: Bearer AKIAIOSFODNN7EXAMPLE" https://out-of-scope.example.com',
      stdout: 'AKIAIOSFODNN7EXAMPLE',
      exit_code: 0
    })
    await page.waitForTimeout(400)
    expect(await count(), 'derivation must not run while paused — a scope_violation names the host')
      .toBe(before)
  })

  test('a marker still records while paused', async () => {
    const before = await count()
    // 201 = row created. The paused path answers 200 with `skipped` instead —
    // both are 2xx, so `curl -sf` in the hook is happy either way.
    expect((await post('marker', { title: 'noted while paused', severity: 'info' })).status).toBe(201)
    await page.waitForTimeout(300)
    expect(await count(), 'marker is pause-exempt').toBe(before + 1)
  })

  test('a forged system event is refused even though system is pause-exempt', async () => {
    // This used to post `system` over HTTP and assert 201, which made the
    // pause exemption look like it depended on an open external door. It does
    // not: no hook or addon posts `system`, and the external allowlist now
    // refuses it, because `system` rows are RedLog's own conclusions about
    // the engagement and forging them forges the record.
    //
    // The exemption itself is proven through the path that actually produces
    // system rows — the two tests below read `recording_paused` /
    // `recording_resumed`, which are written while paused, by RedLog.
    const res = await post('system', { subtype: 'ip_transition', from: 'safe', to: 'exposed' })
    expect(res.status, 'external system must be refused').toBe(403)
  })

  test('resuming restores capture and the pause is bracketed in the log', async () => {
    await setRecording(true)
    const res = await post('shell', { subtype: 'command_end', command: 'after-resume', exit_code: 0 })
    expect(res.status).toBe(201)
    await page.waitForTimeout(400)

    const all = await fetch(`${base}/api/events?limit=1000`, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => r.json()) as { events: Array<{ agentType?: string; data?: Record<string, unknown> }> }
    const subs = all.events.map((e) => e.data?.subtype)
    expect(subs).toContain('recording_paused')
    expect(subs).toContain('recording_resumed')
    expect(JSON.stringify(all.events)).toContain('after-resume')
  })

  test('the pause/resume rows name their origin', async () => {
    // UI path (the toggle above went through the preload bridge).
    const rows = async (): Promise<Array<{ data?: Record<string, unknown> }>> =>
      fetch(`${base}/api/events?agent_type=system&limit=200`, { headers: { authorization: `Bearer ${token}` } })
        .then((r) => r.json()).then((j: { events: Array<{ data?: Record<string, unknown> }> }) => j.events)

    const uiToggles = (await rows()).filter((e) => String(e.data?.subtype).startsWith('recording_'))
    expect(uiToggles.length, 'the earlier UI toggles should be logged').toBeGreaterThan(0)
    expect(uiToggles.every((e) => e.data?.source === 'ui'), 'UI toggles must be labelled ui').toBeTruthy()

    // REST path — what redlog-cli uses.
    await fetch(`${base}/api/recording`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: 'pause' })
    })
    await page.waitForTimeout(250)
    const afterApi = (await rows()).filter((e) => e.data?.subtype === 'recording_paused')
    expect(afterApi.some((e) => e.data?.source === 'api'), 'a REST pause must be labelled api').toBeTruthy()

    // MCP path — what an agent uses. This is the one that matters: an agent
    // that pauses itself now leaves a row saying so.
    await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'redlog_recording', arguments: { action: 'resume' } } })
    })
    await page.waitForTimeout(250)
    const afterMcp = (await rows()).filter((e) => e.data?.subtype === 'recording_resumed')
    expect(afterMcp.some((e) => e.data?.source === 'mcp'), 'an agent pausing itself must be attributable').toBeTruthy()
  })

  test('the chain is intact across the pause', async () => {
    const v = await page.evaluate(async () =>
      (window as unknown as { redlog: { chain: { verify: (o?: { full?: boolean }) => Promise<{ ok: boolean; walked?: number }> } } })
        .redlog.chain.verify({ full: true }))
    expect(v.ok, 'dropping rows before insert must never break prev_hash linkage').toBeTruthy()
  })
})
