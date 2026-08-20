import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, openTestProject } from './helpers'

// v0.9.6 (T2): a built-in-terminal command_end carries `io: {ref, off, len}`
// bracketing its own output inside the session .cast. Needs a real pty — the
// offsets come from the live cast write position, so nothing below is
// reachable from a unit test.

let app: ElectronApplication
let page: Page
let tmpHome = ''
let base = ''
let token = ''

interface TermBridge {
  spawn: (id: string, cols: number, rows: number) => Promise<unknown>
  write: (id: string, data: string) => void
  kill: (id: string) => void
}

const events = async (): Promise<Array<{ id: string; data?: Record<string, unknown> }>> =>
  fetch(`${base}/api/events?agent_type=shell&limit=200`, { headers: { authorization: `Bearer ${token}` } })
    .then((r) => r.json()).then((j: { events: Array<{ id: string; data?: Record<string, unknown> }> }) => j.events)

test.describe.serial('command I/O capture', () => {
  test.beforeAll(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'redlog-io-'))
    app = await electron.launch({
      args: [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' }
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await openTestProject(page, 'command-io')
    await page.waitForTimeout(1500)
    base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()

    // Real pty. The shell hook is auto-sourced into built-in terminals, so
    // command_start / command_end arrive over HTTP exactly as they would for
    // an operator typing.
    await page.evaluate(async () => {
      const t = (window as unknown as { redlog: { terminal: TermBridge } }).redlog.terminal
      await t.spawn('io-test', 80, 24)
    })
    await page.waitForTimeout(2500)
    await page.evaluate(() => {
      const t = (window as unknown as { redlog: { terminal: TermBridge } }).redlog.terminal
      t.write('io-test', 'echo REDLOG_IO_MARKER_OUTPUT\r')
    })
    await page.waitForTimeout(3000)
  })

  test.afterAll(async () => {
    await page.evaluate(() => {
      (window as unknown as { redlog: { terminal: TermBridge } }).redlog.terminal.kill('io-test')
    }).catch(() => {})
    if (app) await app.close()
  })

  test('a .cast was written for the session', async () => {
    const castsDir = join(tmpHome, '.redlog', 'projects')
    const found: string[] = []
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.cast')) found.push(p)
      }
    }
    if (existsSync(castsDir)) walk(castsDir)
    expect(found.length, 'no .cast file produced by the pty session').toBeGreaterThan(0)
    expect(statSync(found[0]).size).toBeGreaterThan(0)
  })

  test('command_end carries an io byte range into the chain', async () => {
    const ends = (await events()).filter(
      (e) => e.data?.subtype === 'command_end' && e.data?.source === 'builtin-terminal'
    )
    expect(ends.length, 'the echo command produced no command_end').toBeGreaterThan(0)

    const marker = ends.find((e) => String(e.data?.command ?? '').includes('REDLOG_IO_MARKER_OUTPUT'))
    expect(marker, 'our echo command was not captured').toBeTruthy()

    const io = marker!.data?.io as { stream?: string; ref?: string; off?: number; len?: number } | undefined
    expect(io, 'command_end has no io field — the cast probe did not fire').toBeTruthy()
    expect(io!.stream).toBe('cast')
    expect(io!.ref).toContain('.cast')
    expect(typeof io!.off, 'off must be a byte offset').toBe('number')
    expect(io!.len, 'the echo printed something, so len must be > 0').toBeGreaterThan(0)

    // The offset is a position in the file, so it has to account for the
    // asciicast header line. It did not: `castBytes` started at 0 and only
    // counted output events, leaving every range short by the header's length
    // and therefore starting mid-line. Reading from there yields no parseable
    // events, which is how replay came to report 0 bytes — on Linux and under
    // bash, while passing under zsh, for two weeks.
    const cast = readFileSync(io!.ref!, 'utf-8')
    const headerLen = cast.indexOf('\n') + 1
    expect(headerLen, 'the cast has a header line').toBeGreaterThan(1)
    expect(io!.off, 'the range must start past the header').toBeGreaterThanOrEqual(headerLen)
    const before = Buffer.from(cast, 'utf-8').subarray(0, io!.off).toString('utf-8')
    expect(before.endsWith('\n'), 'the range must start on a line boundary').toBe(true)
  })

  test('the chain stores only the reference, never the bytes', async () => {
    // v0.6.47 reverted in-chain stdout: TUI output blew past any cap and the
    // hash ended up covering ANSI noise. The io field must not walk that back.
    const marker = (await events()).find(
      (e) => e.data?.subtype === 'command_end' && String(e.data?.command ?? '').includes('REDLOG_IO_MARKER_OUTPUT')
    )
    const io = marker!.data?.io as Record<string, unknown>
    expect(Object.keys(io).sort()).toEqual(['len', 'off', 'ref', 'stream', 'truncated'].filter((k) => k in io).sort())
    expect(JSON.stringify(io)).not.toContain('REDLOG_IO_MARKER_OUTPUT')
  })

  test('replay resolves the output through the byte range', async () => {
    const marker = (await events()).find(
      (e) => e.data?.subtype === 'command_end' && String(e.data?.command ?? '').includes('REDLOG_IO_MARKER_OUTPUT')
    )
    const res = await fetch(`${base}/api/terminal/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ eventId: marker!.id })
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { text?: string; bytes?: number }
    expect(body.bytes, 'replay returned an empty slice').toBeGreaterThan(0)
    // The echo's own output must be inside the bracketed range.
    expect(body.text, 'the byte range did not cover the command output').toContain('REDLOG_IO_MARKER_OUTPUT')
  })
})
