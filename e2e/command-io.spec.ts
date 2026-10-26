import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, makeTempHome, openTestProject } from './helpers'

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
  resize: (id: string, cols: number, rows: number) => void
  kill: (id: string) => void
}

const events = async (): Promise<Array<{ id: string; data?: Record<string, unknown> }>> =>
  fetch(`${base}/api/events?agent_type=shell&limit=200`, { headers: { authorization: `Bearer ${token}` } })
    .then((r) => r.json()).then((j: { events: Array<{ id: string; data?: Record<string, unknown> }> }) => j.events)

test.describe.serial('command I/O capture', () => {
  test.beforeAll(async () => {
    tmpHome = makeTempHome('redlog-io-')
    app = await electron.launch({
      ...(process.env.REDLOG_PACKAGED_APP ? { executablePath: process.env.REDLOG_PACKAGED_APP } : {}),
      args: process.env.REDLOG_PACKAGED_APP ? [] : [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' }
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await openTestProject(page, 'command-io')
    if (process.env.REDLOG_PACKAGED_APP) expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
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
    // Wait for the shell to be READY, not for a fixed 2.5s. The built-in
    // terminal auto-sources the adapter into the fresh pty 600ms after spawn
    // and clears the screen; writing into that window loses characters - this
    // suite has seen `echo` arrive as `cho` under a full-suite load, which
    // then fails a byte-range assertion that has nothing to do with the race.
    // A session_start over HTTP proves the hook is loaded and the prompt is live.
    await expect.poll(
      async () => (await events()).some((e) => e.data?.subtype === 'session_start'),
      { timeout: 20_000, message: 'the built-in terminal never reported session_start' }
    ).toBe(true)
    await page.waitForTimeout(800)
    await page.evaluate(() => {
      const t = (window as unknown as { redlog: { terminal: TermBridge } }).redlog.terminal
      t.resize('io-test', 120, 40)
      t.resize('io-test', 120, 40)
      t.resize('io-test', 0, 0)
      t.write('io-test', 'echo REDLOG_IO_MARKER_OUTPUT\r')
    })
    // And wait for the command itself to land rather than guessing at 3s.
    await expect.poll(
      async () => (await events()).some((e) =>
        e.data?.subtype === 'command_end' && String(e.data?.command ?? '').includes('REDLOG_IO_MARKER_OUTPUT')),
      { timeout: 20_000, message: 'the marker command never reached the chain' }
    ).toBe(true)
  })

  test.afterAll(async () => {
    await page.evaluate(() => {
      (window as unknown as { redlog: { terminal: TermBridge } }).redlog.terminal.kill('io-test')
    }).catch(() => {})
    if (app) await app.close()
  })

  test('a .cast was written for the session', async () => {
    const session = (await events()).find(e => e.data?.subtype === 'session_start' && e.data?.terminalId === 'io-test' && e.data?.source === 'builtin-terminal')
    expect(session?.data?.castPath, 'io-test must reference its own recording').toBeTruthy()
    const castPath = String(session!.data!.castPath)
    expect(existsSync(castPath)).toBe(true)
    expect(statSync(castPath).size).toBeGreaterThan(0)
  })

  test('terminal geometry changes are persisted in asciicast v2', async () => {
    const session = (await events()).find(e => e.data?.subtype === 'session_start' && e.data?.terminalId === 'io-test' && e.data?.source === 'builtin-terminal')
    expect(session?.data?.castPath, 'io-test must reference its own recording').toBeTruthy()
    const frames = readFileSync(String(session!.data!.castPath), 'utf8').trim().split('\n').slice(1).map((line) => JSON.parse(line) as unknown[])
    const resizeFrames = frames.filter((frame) => frame[1] === 'r')
    expect(resizeFrames).toEqual([[expect.any(Number), 'r', '120x40']])
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
  test('a command crosses cast parts and its bundle keeps every saved part', async () => {
    await page.evaluate(async () => {
      const api = (window as any).redlog
      const config = await api.config.get()
      config.terminal.maxCastBytes = 32 * 1024
      await api.config.save(config)
      await api.terminal.spawn('segmented-io', 80, 24)
      api.terminal.write('segmented-io', "python3 -c \"import sys;sys.stdout.write('SEGMENT_BEGIN'+'x'*180000+'SEGMENT_END')\"\r")
    })
    let command: { id: string; data?: Record<string, unknown> } | undefined
    await expect.poll(async () => {
      command = (await events()).find(e => e.data?.subtype === 'command_end' && e.data?.terminalId === 'segmented-io' && String(e.data.command).includes('SEGMENT_BEGIN'))
      return Boolean(command)
    }, { timeout: 30_000 }).toBe(true)
    const response = await fetch(`${base}/api/terminal/replay`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ eventId: command!.id })
    })
    const replay = await response.json() as { text: string; truncated: boolean }
    expect(replay.text).toContain('SEGMENT_BEGIN')
    expect(replay.text).toContain('SEGMENT_END')
    expect(replay.truncated).toBe(false)
    await page.evaluate(() => (window as any).redlog.terminal.kill('segmented-io'))
    let end: any
    await expect.poll(async () => {
      end = (await events()).find(e => e.data?.subtype === 'session_end' && e.data?.terminalId === 'segmented-io')
      return Boolean(end)
    }).toBe(true)
    expect(end.data.castTruncated).toBe(false)
    expect(end.data.castSegments.length).toBeGreaterThan(1)
    const exported = await page.evaluate(async () => {
      const api = (window as any).redlog
      const resolved = await api.data.resolveExportPlan({ format: 'bundle', subset: { kind: 'all' }, maskOutOfScope: false })
      if (!resolved.ok) throw new Error(JSON.stringify(resolved))
      return api.data.executeExportPlan({ planId: resolved.plan.id })
    })
    expect(exported.ok, JSON.stringify(exported)).toBe(true)
    for (const segment of end.data.castSegments) {
      const { basename, join } = await import('node:path')
      const bytes = readFileSync(join(exported.artifactPath, 'casts', basename(segment.path)))
      expect(bytes).toEqual(readFileSync(segment.path))
    }
  })

})
