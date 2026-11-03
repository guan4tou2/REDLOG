import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { Agent, request } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { launchWithTempHome, openView, REPO_ROOT } from './helpers'
import { startStreamSources, proxiedWebSocket, treeRss, hardKill, type StreamSources } from './stream-sources'

/**
 * #291 soak: one capture source at a time, for as long as it is told to run,
 * with the App restarted part way. Each unit the source produces carries its
 * own sequence number, so the end of the run can say, unit by unit, what was
 * kept, what a capture_gap row accounts for, and what is gone with nothing
 * saying so.
 *
 *   REDLOG_SOAK_MINUTES=25 REDLOG_SOAK_SOURCES=http npx playwright test e2e/capture-soak.spec.ts --reporter=line
 *
 *   REDLOG_SOAK_MINUTES           minutes per source (opt-in: unset skips every test)
 *   REDLOG_SOAK_SOURCES           comma list of sse, ws, http, pty; default all four
 *   REDLOG_SOAK_RESTART           quit (the App quits as from the tray), kill (its main
 *                                 process is killed, as by a crash: what it spawned is
 *                                 left running), or none; default quit
 *   REDLOG_SOAK_RESTART_AT        fraction of the run at which to restart, default 0.8
 *   REDLOG_SOAK_SAMPLE_S          seconds between samples, default 60
 *   REDLOG_SOAK_OUT_DIR           results directory, default test-results
 *   REDLOG_SOAK_MAIN_GROWTH_MIB   main-process growth allowed after warm-up, default 64
 *   REDLOG_SOAK_MITM_GROWTH_MIB   mitmdump growth allowed after warm-up, default 64
 *
 * Shapes, each with a default sized to put the source under real load:
 *
 *   REDLOG_SOAK_SSE_MS=50 REDLOG_SOAK_SSE_PAD=512        one SSE event every 50 ms
 *   REDLOG_SOAK_WS_PUSH_MS=100 REDLOG_SOAK_WS_BYTES=16384 server pushes; the client
 *                                                       sends a text every REDLOG_SOAK_WS_SEND_MS=500
 *   REDLOG_SOAK_HTTP_RPS=50 REDLOG_SOAK_HTTP_BYTES=512    steady requests, plus a burst of
 *   REDLOG_SOAK_HTTP_BURST_EVERY_S=300                  REDLOG_SOAK_HTTP_BURST_CONCURRENCY=32
 *   REDLOG_SOAK_HTTP_BURST_S=10                         closed-loop clients for that long
 *   REDLOG_SOAK_PTY_MS=50                               one numbered line per 50 ms
 *
 * Every sample records the main process and mitmdump separately, the project
 * directory by top-level entry, the addon's spool and in-flight marker (its
 * send-queue bound), and the capture_gap rows by reason. A second, 1 s poller
 * keeps the in-flight marker's highest bound, because a 64-slot queue can fill
 * and drain inside one sample interval. Counts are read from timeline.db with
 * a read-only connection of the test's own, so the soak's reads are not part
 * of the App memory it measures.
 */
const minutes = Number(process.env.REDLOG_SOAK_MINUTES ?? 0)
const env = (key: string, fallback: number): number => Number(process.env[key] ?? fallback)
const sources = (process.env.REDLOG_SOAK_SOURCES ?? 'sse,ws,http,pty').split(',').map(s => s.trim())
const restartMode = (process.env.REDLOG_SOAK_RESTART ?? 'quit') as 'quit' | 'kill' | 'none'

test.skip(!minutes, 'opt-in: set REDLOG_SOAK_MINUTES')

const MiB = 1 << 20
// How far a unit's own time may sit outside a gap's window and still count as
// covered by it: the addon stamps a window when it refuses, the client stamps
// a unit when it arrives, and the two clocks are a network hop apart.
const COVER_SLACK_MS = 3000

type Source = 'sse' | 'ws' | 'http' | 'pty'

interface Gap { reason: string; delivery: string; units: number | null; started: number; ended: number }

interface Ctx {
  app: ElectronApplication
  page: Page
  home: string
  projectId: string
  mitmPid: number | null
  proxy: URL | null
  phase: 'before' | 'after'
}

function version(cmd: string, args: string[]): string {
  try { return execFileSync(cmd, args, { encoding: 'utf8', cwd: REPO_ROOT }).trim().split(/\r?\n/).join(' | ') }
  catch (e) { return `unavailable: ${(e as Error).message.split('\n')[0]}` }
}

function dirBytes(target: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  const walk = (p: string): void => {
    let st: fs.Stats
    try { st = fs.lstatSync(p) } catch { return }
    if (st.isDirectory()) { for (const name of fs.readdirSync(p)) walk(path.join(p, name)) }
    else { files++; bytes += st.size }
  }
  walk(target)
  return { files, bytes }
}

function projectDir(home: string): string | null {
  const root = path.join(home, '.redlog', 'projects')
  const found = fs.existsSync(root) ? fs.readdirSync(root).map(name => path.join(root, name)).filter(p => fs.existsSync(path.join(p, 'timeline.db'))) : []
  return found[0] ?? null
}

/** The project directory by top-level entry; the DB's WAL and SHM count with it. */
function projectSizes(home: string): Record<string, number> {
  const dir = projectDir(home)
  if (!dir) return {}
  const out: Record<string, number> = {}
  for (const name of fs.readdirSync(dir)) {
    const key = name.startsWith('timeline.db') ? 'timeline.db' : name
    out[key] = (out[key] ?? 0) + dirBytes(path.join(dir, name)).bytes
  }
  return out
}

/** The addon's in-flight markers: how many there are and the bound each holds,
 *  which is the send queue's occupancy rounded up to 8. */
function inflight(home: string): { markers: number; bound: number } {
  const dir = path.join(home, '.redlog', 'inflight')
  let markers = 0
  let bound = 0
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      markers++
      try {
        const marker = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
        for (const entry of marker.identities ?? []) bound += Number(entry.upper_bound) || 0
      } catch { /* mid-replace; the next read sees it */ }
    }
  } catch { /* no directory yet */ }
  return { markers, bound }
}

type Db = import('better-sqlite3').Database

function openDb(home: string): Db | null {
  const dir = projectDir(home)
  if (!dir) return null
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3') as typeof import('better-sqlite3')
  return new Database(path.join(dir, 'timeline.db'), { readonly: true, fileMustExist: true })
}

/** Rows of one subtype across both tiers. */
function rows(db: Db, subtype: string, columns = 'data'): Array<Record<string, any>> {
  const sql = `SELECT ${columns} FROM events WHERE subtype = ? UNION ALL SELECT ${columns} FROM events_logged WHERE subtype = ?`
  return db.prepare(sql).all(subtype, subtype) as Array<Record<string, any>>
}

function counts(db: Db): Record<string, number> {
  const out: Record<string, number> = {}
  for (const table of ['events', 'events_logged']) {
    for (const row of db.prepare(`SELECT subtype, count(*) AS n FROM ${table} GROUP BY subtype`).all() as Array<{ subtype: string | null; n: number }>) {
      const key = row.subtype ?? '(none)'
      out[key] = (out[key] ?? 0) + row.n
    }
  }
  return out
}

/** The addon's POST timeout: a delivery-unconfirmed record is written when a
 *  send fails, up to this long after the event was handed to it. */
const ADDON_POST_TIMEOUT_MS = 5000

function gaps(db: Db): Gap[] {
  return rows(db, 'capture_gap').map(r => JSON.parse(r.data)).map(d => ({
    reason: String(d.reason), delivery: String(d.capture_delivery),
    units: Number.isInteger(d.skipped_units) ? d.skipped_units : null,
    started: Number(d.gap_started_at ?? (d.reason === 'delivery-unconfirmed' ? d.reported_at - ADDON_POST_TIMEOUT_MS : d.reported_at)),
    ended: Number(d.gap_ended_at ?? d.reported_at)
  }))
}

function summarizeGaps(list: Gap[]): Record<string, { rows: number; units: number; unknownCountRows: number }> {
  const out: Record<string, { rows: number; units: number; unknownCountRows: number }> = {}
  for (const g of list) {
    const r = out[g.reason] ??= { rows: 0, units: 0, unknownCountRows: 0 }
    r.rows++
    if (g.units === null) r.unknownCountRows++
    else r.units += g.units
  }
  return out
}

/** Bytes a saved body holds: inline, or the sidecar it was moved to. */
function savedBody(home: string, data: Record<string, any>, field: string): Buffer | null {
  const inline = data[field]
  if (inline?.data !== undefined) return Buffer.from(inline.data, inline.encoding === 'base64' ? 'base64' : 'utf8')
  const ref = data[`${field}_ref`]
  const dir = projectDir(home)
  if (!ref?.file || !dir) return null
  try { return fs.readFileSync(path.join(dir, 'http-bodies', ref.file)) } catch { return null }
}

/** Split units the client saw into kept, missing-but-covered-by-a-gap, and
 *  missing with nothing to say so. A unit is covered when it fell inside a
 *  gap's time window (plus slack); gaps carry counts and windows, not ids.
 *  A gap with no window (the App's own `gap-unsaved`, for a gap the addon
 *  could not write) covers by count only: as many of the rest as it names. */
function account(seen: Map<number, number>, saved: Set<number>, gapList: Gap[]): Record<string, any> {
  const covered: number[] = []
  const uncovered: number[] = []
  const windowed = gapList.filter(g => Number.isFinite(g.started) && Number.isFinite(g.ended))
  for (const [seq, at] of seen) {
    if (saved.has(seq)) continue
    const inGap = windowed.some(g => at >= g.started - COVER_SLACK_MS && at <= g.ended + COVER_SLACK_MS)
    ;(inGap ? covered : uncovered).push(seq)
  }
  uncovered.sort((a, b) => a - b)
  const countOnly = gapList.filter(g => !windowed.includes(g)).reduce((sum, g) => sum + (g.units ?? 0), 0)
  const byCount = Math.min(countOnly, uncovered.length)
  const silent = uncovered.slice(byCount)
  const extra = [...saved].filter(s => !seen.has(s)).length
  return {
    seen: seen.size, kept: seen.size - covered.length - uncovered.length, coveredByGap: covered.length, coveredByCountOnlyGap: byCount,
    silent: silent.length, silentFirst: silent.slice(0, 20), savedNotSeenByClient: extra
  }
}

async function processRss(app: ElectronApplication): Promise<Record<string, number>> {
  return app.evaluate(({ app }) => {
    const byType: Record<string, number> = {}
    for (const p of app.getAppMetrics()) byType[p.type] = (byType[p.type] ?? 0) + p.memory.workingSetSize * 1024
    return byType
  })
}

async function launch(home?: string): Promise<{ app: ElectronApplication; page: Page; tmpHome: string }> {
  const launched = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP, home ? { home } : {})
  await launched.page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
  return launched
}

/** The managed proxy, started by the project's open (auto-start) or asked for. */
async function captureRunning(page: Page): Promise<{ proxy: URL; pid: number }> {
  await page.evaluate(() => window.redlog.httpCapture.status().then(s => s.state === 'running' ? s : window.redlog.httpCapture.start()))
  // A start that fails says why: the state alone named nothing.
  await expect.poll(() => page.evaluate(() => window.redlog.httpCapture.status().then(s => s.state === 'failed' ? `failed: ${s.error}` : s.state)), { timeout: 60_000 }).toBe('running')
  const status = await page.evaluate(() => window.redlog.httpCapture.status())
  return { proxy: new URL(status.url!), pid: status.pid as number }
}

/** What a source does: start (or resume after the restart), stop, and say
 *  what it has seen so far for a sample. */
interface Driver {
  start: (ctx: Ctx) => Promise<void>
  stop: () => Promise<void>
  progress: () => Record<string, number> | Promise<Record<string, number>>
  /** Read back from disk at the end of the run. */
  verdict: (ctx: Ctx, db: Db, gapList: Gap[]) => Promise<Record<string, any>>
}

function sseDriver(server: StreamSources): Driver {
  const intervalMs = env('REDLOG_SOAK_SSE_MS', 50)
  const pad = env('REDLOG_SOAK_SSE_PAD', 512)
  // One connection per phase; the server numbers each connection from 1, so
  // the phase is part of the key.
  const seen = { before: new Map<number, number>(), after: new Map<number, number>() }
  let current: import('node:http').ClientRequest | null = null
  return {
    async start(ctx) {
      const phase = ctx.phase
      const target = server.url(`/sse?interval=${intervalMs}&pad=${pad}&phase=${phase}`)
      // Parsed as it arrives: the stream is tens of MB by the end, too much
      // to re-read whole on every tick.
      let carry = ''
      current = request({ host: ctx.proxy!.hostname, port: ctx.proxy!.port, path: target, headers: { host: new URL(target).host } }, res => {
        res.setEncoding('utf8')
        res.on('data', (text: string) => {
          const events = (carry + text).split('\n\n')
          carry = events.pop() ?? ''
          const now = Date.now()
          for (const e of events) { const m = /^id: (\d+)$/m.exec(e); if (m) seen[phase].set(Number(m[1]), now) }
        })
        res.on('error', () => {})
      })
      current.on('error', () => {})
      current.end()
    },
    async stop() { current?.destroy() },
    progress: () => ({ sseSeenBefore: seen.before.size, sseSeenAfter: seen.after.size }),
    async verdict(ctx, db, gapList) {
      const byFlow = new Map<string, { url: string; parts: Array<{ seq: number; bytes: Buffer | null }> }>()
      for (const r of rows(db, 'http_response_chunk')) {
        const d = JSON.parse(r.data)
        const flow = byFlow.get(d.flow_id) ?? { url: String(d.url ?? ''), parts: [] }
        flow.parts.push({ seq: Number(d.seq), bytes: savedBody(ctx.home, d, 'response_body') })
        byFlow.set(d.flow_id, flow)
      }
      const out: Record<string, any> = {}
      for (const phase of ['before', 'after'] as const) {
        const entry = [...byFlow.entries()].find(([, f]) => f.url.includes(`phase=${phase}`))
        const saved = new Set<number>()
        let chunkSeqGaps = 0
        let unreadable = 0
        if (entry) {
          const parts = entry[1].parts.sort((a, b) => a.seq - b.seq)
          chunkSeqGaps = parts.filter((p, i) => i > 0 && p.seq !== parts[i - 1].seq + 1).length
          unreadable = parts.filter(p => !p.bytes).length
          const text = Buffer.concat(parts.map(p => p.bytes ?? Buffer.alloc(0))).toString('utf8')
          for (const m of text.matchAll(/^id: (\d+)\n/gm)) saved.add(Number(m[1]))
        }
        out[phase] = {
          flow: entry?.[0] ?? null,
          chunks: entry?.[1].parts.length ?? 0, chunkSeqGaps, unreadableChunks: unreadable,
          completion: entry ? await ctx.page.evaluate(id => window.redlog.events.streamCompletion(id), entry[0]) : null,
          ...account(seen[phase], saved, gapList)
        }
      }
      return out
    }
  }
}

function wsDriver(server: StreamSources): Driver {
  const pushMs = env('REDLOG_SOAK_WS_PUSH_MS', 100)
  const bytes = env('REDLOG_SOAK_WS_BYTES', 16384)
  const sendMs = env('REDLOG_SOAK_WS_SEND_MS', 500)
  const seen = { before: { server: new Map<number, number>(), client: new Map<number, number>() }, after: { server: new Map<number, number>(), client: new Map<number, number>() } }
  let ws: import('ws').WebSocket | null = null
  let timer: NodeJS.Timeout | null = null
  return {
    async start(ctx) {
      const phase = ctx.phase
      const socket = await proxiedWebSocket(ctx.proxy!, server.url(`/ws?push=${pushMs}&size=${bytes}&phase=${phase}`))
      ws = socket
      socket.on('message', (data, isBinary) => {
        if (isBinary) seen[phase].server.set((data as Buffer).readUInt32BE(0), Date.now())
      })
      let n = 0
      if (timer) clearInterval(timer)
      timer = setInterval(() => {
        if (socket.readyState !== 1) return
        n++
        socket.send(`client ${n} 中文`)
        seen[phase].client.set(n, Date.now())
      }, sendMs)
    },
    async stop() { if (timer) clearInterval(timer); ws?.terminate() },
    progress: () => ({ wsServerSeenBefore: seen.before.server.size, wsServerSeenAfter: seen.after.server.size, wsClientSentBefore: seen.before.client.size, wsClientSentAfter: seen.after.client.size }),
    async verdict(ctx, db, gapList) {
      const byFlow = new Map<string, { url: string; server: Set<number>; client: Set<number>; unreadable: number; messages: number }>()
      for (const r of rows(db, 'ws_message')) {
        const d = JSON.parse(r.data)
        const flow = byFlow.get(d.flow_id) ?? { url: String(d.url ?? ''), server: new Set<number>(), client: new Set<number>(), unreadable: 0, messages: 0 }
        flow.messages++
        const body = savedBody(ctx.home, d, 'ws_body')
        if (!body) flow.unreadable++
        else if (d.direction === 'server' && d.message_type === 'binary' && body.length >= 8) flow.server.add(body.readUInt32BE(0))
        else if (d.direction === 'client') { const m = /^client (\d+) /.exec(body.toString('utf8')); if (m) flow.client.add(Number(m[1])) }
        byFlow.set(d.flow_id, flow)
      }
      const ends = rows(db, 'websocket_end').map(r => JSON.parse(r.data))
      const out: Record<string, any> = {}
      for (const phase of ['before', 'after'] as const) {
        const entry = [...byFlow.entries()].find(([, f]) => f.url.includes(`phase=${phase}`))
        out[phase] = {
          flow: entry?.[0] ?? null,
          messages: entry?.[1].messages ?? 0,
          unreadable: entry?.[1].unreadable ?? 0,
          end: entry ? ends.find(e => e.flow_id === entry[0]) ?? null : null,
          completion: entry ? await ctx.page.evaluate(id => window.redlog.events.streamCompletion(id), entry[0]) : null,
          server: account(seen[phase].server, entry?.[1].server ?? new Set(), gapList),
          client: account(seen[phase].client, entry?.[1].client ?? new Set(), gapList)
        }
      }
      return out
    }
  }
}

function httpDriver(server: StreamSources): Driver {
  const rps = env('REDLOG_SOAK_HTTP_RPS', 50)
  const bodyBytes = env('REDLOG_SOAK_HTTP_BYTES', 512)
  const burstEveryMs = env('REDLOG_SOAK_HTTP_BURST_EVERY_S', 300) * 1000
  const burstMs = env('REDLOG_SOAK_HTTP_BURST_S', 10) * 1000
  const burstConcurrency = env('REDLOG_SOAK_HTTP_BURST_CONCURRENCY', 32)
  // seq → time the client had the whole response; failures are counted, not
  // kept: a request the proxy never answered is not capture's to lose.
  const ok = new Map<number, number>()
  const tally = { sent: 0, ok: 0, failed: 0, bursts: 0, burstRequests: 0 }
  let seq = 0
  let running = false
  let proxy: URL | null = null
  let steady: NodeJS.Timeout | null = null
  let burstTimer: NodeJS.Timeout | null = null
  let burstUntil = 0
  // Kept-alive connections to the proxy: a fresh socket per request runs a
  // half-hour soak out of ephemeral ports on Windows.
  let agent = new Agent({ keepAlive: true, maxSockets: 64 })
  const one = (): Promise<void> => new Promise(resolve => {
    if (!proxy) { resolve(); return }
    const n = ++seq
    tally.sent++
    const target = server.url(`/large?bytes=${bodyBytes}&seq=${n}`)
    const req = request({ host: proxy.hostname, port: proxy.port, path: target, headers: { host: new URL(target).host }, agent }, res => {
      let got = 0
      res.on('data', (d: Buffer) => { got += d.length })
      res.on('end', () => { if (res.statusCode === 200 && got === bodyBytes) { ok.set(n, Date.now()); tally.ok++ } else tally.failed++; resolve() })
      res.on('error', () => { tally.failed++; resolve() })
    })
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')))
    req.on('error', () => { tally.failed++; resolve() })
    req.end()
  })
  const burst = async (): Promise<void> => {
    tally.bursts++
    burstUntil = Date.now() + burstMs
    await Promise.all(Array.from({ length: burstConcurrency }, async () => {
      while (running && Date.now() < burstUntil) { tally.burstRequests++; await one() }
    }))
  }
  return {
    async start(ctx) {
      // The old proxy's sockets died with it.
      agent.destroy()
      agent = new Agent({ keepAlive: true, maxSockets: 64 })
      proxy = ctx.proxy
      running = true
      // A second start (after the restart) replaces the first one's timers.
      if (steady) clearInterval(steady)
      if (burstTimer) clearInterval(burstTimer)
      steady = setInterval(() => { void one() }, Math.max(1, Math.round(1000 / rps)))
      burstTimer = setInterval(() => { void burst() }, burstEveryMs)
    },
    async stop() {
      running = false
      if (steady) clearInterval(steady)
      if (burstTimer) clearInterval(burstTimer)
      await new Promise(r => setTimeout(r, 2000))
      agent.destroy()
    },
    progress: () => ({ httpSent: tally.sent, httpOk: tally.ok, httpFailed: tally.failed, httpBursts: tally.bursts }),
    async verdict(_ctx, db, gapList) {
      const saved = new Set<number>()
      for (const r of rows(db, 'http_response', "json_extract(data, '$.url') AS url")) {
        const m = /[?&]seq=(\d+)/.exec(String(r.url ?? ''))
        if (m) saved.add(Number(m[1]))
      }
      const started = new Set<number>()
      for (const r of rows(db, 'http_request_start', "json_extract(data, '$.url') AS url")) {
        const m = /[?&]seq=(\d+)/.exec(String(r.url ?? ''))
        if (m) started.add(Number(m[1]))
      }
      const okSeqs = [...ok.keys()]
      return {
        client: { ...tally, burstConcurrency, burstMs, rps },
        responses: account(ok, saved, gapList),
        requestStartsMissingForOk: okSeqs.filter(s => !started.has(s)).length
      }
    }
  }
}

function ptyDriver(): Driver {
  const lineMs = env('REDLOG_SOAK_PTY_MS', 50)
  const panes: Record<'before' | 'after', string | null> = { before: null, after: null }
  let page: Page | null = null
  let phase: 'before' | 'after' = 'before'
  return {
    async start(ctx) {
      page = ctx.page
      phase = ctx.phase
      const shell = await page.evaluate(async (win) => {
        const shells = await window.redlog.terminal.shells()
        const pick = shells.find(s => (win ? /powershell/i : /\b(bash|zsh)\b/i).test(s.label)) ?? shells[0]
        localStorage.setItem('redlog-terminal-shell', pick.id)
        return pick.label
      }, process.platform === 'win32')
      // The renderer reads the active project once on mount.
      await page.reload()
      await page.waitForSelector('[data-testid="view-root"]', { timeout: 30_000 })
      await openView(page, 'terminal')
      await expect.poll(() => page!.evaluate(async () => (await window.redlog.terminal.list()).length), { timeout: 30_000 }).toBeGreaterThan(0)
      const pane = await page.evaluate(async () => (await window.redlog.terminal.list())[0])
      await expect.poll(() => page!.evaluate(async () => (await window.redlog.terminal.list())[0].recording), { timeout: 30_000 }).toBe(true)
      panes[phase] = pane.id
      // The renderer's own count of what it was shown: a line the App displayed
      // and did not save is the loss a cast read-back alone cannot see.
      await page.evaluate(({ id, tag }) => {
        const w = window as unknown as { __soakMax: Record<string, number> }
        w.__soakMax = w.__soakMax ?? {}
        w.__soakMax[tag] = 0
        window.redlog.terminal.onData(id, d => {
          for (const m of d.matchAll(new RegExp(`${tag}-(\\d{7})`, 'g'))) w.__soakMax[tag] = Math.max(w.__soakMax[tag], Number(m[1]))
        })
      }, { id: pane.id, tag: phase === 'before' ? 'SOAKA' : 'SOAKB' })
      await page.waitForTimeout(3000)
      const tag = phase === 'before' ? 'SOAKA' : 'SOAKB'
      const cmd = process.platform === 'win32'
        ? `$i=0; while ($true) { $i++; '${tag}-{0:D7} {1}' -f $i, ('x' * 100); Start-Sleep -Milliseconds ${lineMs} }\r`
        : `i=0; while :; do i=$((i+1)); printf '${tag}-%07d %0100d\\n' $i $i; sleep ${lineMs / 1000}; done\r`
      await page.evaluate(({ id, cmd }) => window.redlog.terminal.write(id, cmd), { id: pane.id, cmd })
      ;(ctx as Ctx & { shell?: string }).shell = shell
    },
    async stop() {
      if (!page || !panes[phase]) return
      // Ctrl-C, then exit: the session ends the way an operator ends it.
      await page.evaluate(id => window.redlog.terminal.write(id, '\x03'), panes[phase]!).catch(() => {})
      await page.waitForTimeout(1000)
      await page.evaluate(id => window.redlog.terminal.write(id, 'exit\r'), panes[phase]!).catch(() => {})
    },
    progress: async () => page ? page.evaluate(async () => ({
      ptyCastBytes: Number((await window.redlog.terminal.list())[0]?.castBytes ?? 0),
      ...((window as unknown as { __soakMax?: Record<string, number> }).__soakMax ?? {})
    })).catch(() => ({})) : {},
    async verdict(ctx, db) {
      const ends = rows(db, 'session_end').map(r => JSON.parse(r.data))
      const shown = await ctx.page.evaluate(() => (window as unknown as { __soakMax?: Record<string, number> }).__soakMax ?? {}).catch(() => ({} as Record<string, number>))
      const out: Record<string, any> = { shownAfter: shown.SOAKB ?? null, shownBeforeAtRestart: (ctx as Ctx & { shownBefore?: number }).shownBefore ?? null }
      for (const p of ['before', 'after'] as const) {
        const id = panes[p]
        const end = ends.find(e => e.terminalId === id) ?? null
        if (!end) { out[p] = { pane: id, sessionEnd: null }; continue }
        const parts: string[] = end.castSegments?.length ? end.castSegments.map((s: { path: string }) => s.path) : [String(end.castPath)]
        const bytes = Buffer.concat(parts.filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f)))
        const frames = bytes.toString('utf8').split('\n').filter(Boolean).slice(1).flatMap(line => { try { return [JSON.parse(line) as [number, string, string]] } catch { return [] } })
        const output = frames.filter(f => f[1] === 'o').map(f => f[2]).join('')
        const tag = p === 'before' ? 'SOAKA' : 'SOAKB'
        // ConPTY repaints: a line can appear more than once. Holes are what count.
        // The trailing [x0] keeps the typed command itself, which names the tag, out.
        const nums = [...output.matchAll(new RegExp(`${tag}-(\\d{7}) [x0]`, 'g'))].map(m => Number(m[1]))
        const set = new Set(nums)
        const max = nums.reduce((a, b) => Math.max(a, b), 0)
        const holes: number[] = []
        for (let n = 1; n <= max; n++) if (!set.has(n)) holes.push(n)
        out[p] = {
          pane: id, reason: end.reason, recovered: end.recovered ?? false,
          claimedBytes: end.castBytes, claimedSha256: end.castSha256, parts: parts.length,
          castBytes: bytes.length, castSha256: createHash('sha256').update(bytes).digest('hex'),
          lines: { maxSaved: max, unique: set.size, repeats: nums.length - set.size, holes: holes.length, holesFirst: holes.slice(0, 20) }
        }
      }
      return out
    }
  }
}

for (const source of ['sse', 'ws', 'http', 'pty'] as Source[]) {
  test(`${source} capture holds over a long run and across an App restart`, async () => {
    test.skip(!sources.includes(source), `not in REDLOG_SOAK_SOURCES`)
    // Untimed: requireMitmdump()'s 10 s probe skips at random where a cold
    // `mitmdump --version` takes 7-14 s (Windows, Defender scanning the shim).
    const mitmdump = version('mitmdump', ['--version'])
    test.skip(mitmdump.startsWith('unavailable'), 'Requires installed mitmdump')
    const durationMs = minutes * 60_000
    test.setTimeout(durationMs + 15 * 60_000)
    const budget = { mainGrowthMiB: env('REDLOG_SOAK_MAIN_GROWTH_MIB', 64), mitmGrowthMiB: env('REDLOG_SOAK_MITM_GROWTH_MIB', 64) }
    const restartAt = restartMode === 'none' ? Infinity : env('REDLOG_SOAK_RESTART_AT', 0.8) * durationMs
    const sampleMs = env('REDLOG_SOAK_SAMPLE_S', 60) * 1000
    const outDir = process.env.REDLOG_SOAK_OUT_DIR ?? path.join(REPO_ROOT, 'test-results')
    fs.mkdirSync(outDir, { recursive: true })
    const out = path.join(outDir, `capture-soak-${source}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    const samplesFile = out.replace(/\.json$/, '.samples.jsonl')
    const result: Record<string, any> = {
      source, minutes, restart: restartMode, restartAtMinute: Number.isFinite(restartAt) ? +(restartAt / 60_000).toFixed(1) : null, budget,
      os: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version,
      mitmdump,
      commit: version('git', ['rev-parse', 'HEAD']),
      dirty: version('git', ['status', '--porcelain', '--untracked-files=no']) !== '',
      addonSha256: createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, 'hooks', 'mitmproxy-addon.py'))).digest('hex'),
      packagedApp: process.env.REDLOG_PACKAGED_APP ?? null,
      startedAt: new Date().toISOString()
    }
    const save = (): void => fs.writeFileSync(out, JSON.stringify(result, null, 2))
    const server = await startStreamSources()
    const driver = source === 'sse' ? sseDriver(server) : source === 'ws' ? wsDriver(server) : source === 'http' ? httpDriver(server) : ptyDriver()

    const first = await launch()
    const ctx: Ctx = { app: first.app, page: first.page, home: first.tmpHome, projectId: '', mitmPid: null, proxy: null, phase: 'before' }
    const tail: string[] = []
    const watch = (app: ElectronApplication): void => {
      const keep = (line: string): void => { tail.push(line); if (tail.length > 80) tail.shift() }
      app.process().stdout?.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach(keep))
      app.process().stderr?.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach(l => keep(`[err] ${l}`)))
    }
    watch(ctx.app)
    let queuePeak = { bound: 0, at: 0, markersSeen: 0 }
    const queuePoll = setInterval(() => {
      const q = inflight(ctx.home)
      if (q.markers) queuePeak.markersSeen++
      if (q.bound > queuePeak.bound) queuePeak = { ...queuePeak, bound: q.bound, at: Date.now() }
    }, 1000)
    // The API's answer time, once a second. The addon gives up on a POST after
    // 5 s and writes delivery-unconfirmed; a stall that long is where that
    // record comes from, so the run says when the API stalled and for how long.
    const api = { probes: 0, over1s: 0, over5s: 0, maxMs: 0, maxAt: 0, stalls: [] as Array<{ t: number; ms: number; phase: string }> }
    let probing = false
    const apiPoll = setInterval(() => {
      if (probing) return
      let port = ''
      try { port = fs.readFileSync(path.join(ctx.home, '.redlog', 'api-port'), 'utf8').trim() } catch { return }
      probing = true
      const begun = Date.now()
      const phase = ctx.phase
      const done = (): void => {
        const ms = Date.now() - begun
        probing = false
        api.probes++
        if (ms > 1000) { api.over1s++; if (api.stalls.length < 200) api.stalls.push({ t: begun, ms, phase }) }
        if (ms > 5000) api.over5s++
        if (ms > api.maxMs) { api.maxMs = ms; api.maxAt = begun }
      }
      const req = request({ host: '127.0.0.1', port, path: '/api/health', agent: false }, res => { res.resume(); res.on('end', done) })
      req.setTimeout(30_000, () => req.destroy())
      req.on('error', () => { probing = false })
      req.end()
    }, 1000)
    try {
      // The local sources are the engagement's target: in-scope traffic is the
      // normal case, and out-of-scope adds a scope_violation row per request.
      const project = await ctx.page.evaluate(() => window.redlog.project.create('capture-soak', {
        network: { offline: true }, scope: { enforcement: 'warn', targets: ['127.0.0.1'], excludeTargets: [] }
      } as never))
      ctx.projectId = (project as { id: string }).id
      const cap = await captureRunning(ctx.page)
      ctx.proxy = cap.proxy; ctx.mitmPid = cap.pid
      await driver.start(ctx)

      const samples: Array<Record<string, any>> = []
      const started = Date.now()
      let restarted = false
      let nextSample = started
      const sample = async (): Promise<void> => {
        const byType = await processRss(ctx.app)
        const db = openDb(ctx.home)
        const c = db ? counts(db) : {}
        const g = db ? summarizeGaps(gaps(db)) : {}
        db?.close()
        const spool = dirBytes(path.join(ctx.home, '.redlog', 'pending'))
        const s = {
          t: Math.round((Date.now() - started) / 1000), phase: ctx.phase,
          mainRss: byType.Browser ?? 0, appRss: Object.values(byType).reduce((a, b) => a + b, 0), rssByType: byType,
          mitmRss: ctx.mitmPid ? treeRss(ctx.mitmPid) : 0,
          project: projectSizes(ctx.home),
          spool, inflight: inflight(ctx.home), queuePeakBound: queuePeak.bound, apiMaxMs: api.maxMs, apiOver5s: api.over5s,
          events: c, gaps: g,
          ...(await driver.progress())
        }
        samples.push(s)
        fs.appendFileSync(samplesFile, JSON.stringify(s) + '\n')
      }
      while (Date.now() - started < durationMs) {
        if (Date.now() >= nextSample) { await sample(); nextSample += sampleMs }
        if (!restarted && Date.now() - started >= restartAt) {
          restarted = true
          await sample()
          // The moment the App goes: what the clients had, what was saved.
          if (source === 'pty') (ctx as Ctx & { shownBefore?: number }).shownBefore = await ctx.page.evaluate(() => (window as unknown as { __soakMax: Record<string, number> }).__soakMax.SOAKA)
          const atRestart: Record<string, any> = { t: Math.round((Date.now() - started) / 1000), progress: await driver.progress(), inflight: inflight(ctx.home) }
          const oldMitm = ctx.mitmPid
          // A crash takes the main process only: what it spawned (mitmdump)
          // is not killed with it, so neither is it here.
          if (restartMode === 'kill') {
            try { process.kill(ctx.app.process().pid!, 'SIGKILL') } catch (e) { atRestart.killError = (e as Error).message }
          }
          // Bounded: a close that does not return is a finding, not a reason
          // to spend the rest of the run waiting on it.
          const closed = await Promise.race([ctx.app.close().then(() => true, () => true), new Promise<boolean>(r => setTimeout(() => r(false), 60_000))])
          atRestart.closedWithin60s = closed
          if (!closed) { try { hardKill(ctx.app.process().pid!) } catch { /* already gone */ } }
          // The proxy has to be gone before the next one binds its port; a
          // launcher shim that leaves its worker behind would show up here.
          await new Promise(r => setTimeout(r, 2000))
          atRestart.mitmTreeAfterQuitBytes = oldMitm ? treeRss(oldMitm) : 0
          atRestart.inflightAfterQuit = inflight(ctx.home)
          atRestart.spoolAfterQuit = dirBytes(path.join(ctx.home, '.redlog', 'pending'))
          const again = await launch(ctx.home)
          ctx.app = again.app; ctx.page = again.page; ctx.phase = 'after'
          watch(ctx.app)
          const reopenAt = Date.now()
          result.restartRecord = atRestart
          save()
          await ctx.page.evaluate(id => window.redlog.project.open(id), ctx.projectId)
          const cap2 = await captureRunning(ctx.page)
          ctx.proxy = cap2.proxy; ctx.mitmPid = cap2.pid
          atRestart.downSeconds = +((Date.now() - started) / 1000 - atRestart.t).toFixed(1)
          atRestart.reopenMs = Date.now() - reopenAt
          atRestart.inflightAfterReopen = inflight(ctx.home)
          result.restartRecord = atRestart
          save()
          await driver.start(ctx)
          await sample()
        }
        await new Promise(r => setTimeout(r, 1000))
      }
      await driver.stop()
      // The spool drains every 30 s; wait past one drain and until the
      // counts stop moving before reading the verdict.
      let previous = ''
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 10_000))
        const db = openDb(ctx.home)!
        const now = JSON.stringify(counts(db))
        db.close()
        if (i >= 3 && now === previous) break
        previous = now
      }
      await sample()
      clearInterval(queuePoll); clearInterval(apiPoll)

      const db = openDb(ctx.home)!
      const gapList = gaps(db)
      result.gaps = summarizeGaps(gapList)
      result.gapRows = gapList
      result.events = counts(db)
      result.verdict = await driver.verdict(ctx, db, gapList)
      db.close()
      result.queuePeak = queuePeak
      result.api = { ...api, stalls: api.stalls.map(s => ({ ...s, t: Math.round((s.t - Date.parse(result.startedAt)) / 1000) })) }
      result.spoolAtEnd = dirBytes(path.join(ctx.home, '.redlog', 'pending'))
      result.projectAtEnd = projectSizes(ctx.home)
      result.samples = samples.length

      // Memory: growth in the steady phase, from the end of its first tenth
      // to the last sample before the restart.
      const steady = samples.filter(s => s.phase === 'before')
      const warm = steady[Math.max(1, Math.floor(steady.length / 10))] ?? steady[0]
      const last = steady[steady.length - 1]
      const mib = (n: number): number => +(n / MiB).toFixed(1)
      result.memory = {
        mainWarmMiB: mib(warm.mainRss), mainLastMiB: mib(last.mainRss), mainPeakMiB: mib(Math.max(...steady.map(s => s.mainRss))),
        appWarmMiB: mib(warm.appRss), appLastMiB: mib(last.appRss),
        mitmWarmMiB: mib(warm.mitmRss), mitmLastMiB: mib(last.mitmRss), mitmPeakMiB: mib(Math.max(...steady.map(s => s.mitmRss)))
      }
      result.memory.mainGrowthMiB = +(result.memory.mainLastMiB - result.memory.mainWarmMiB).toFixed(1)
      result.memory.mitmGrowthMiB = +(result.memory.mitmLastMiB - result.memory.mitmWarmMiB).toFixed(1)
      result.finishedAt = new Date().toISOString()
      save()

      expect(result.memory.mainGrowthMiB, 'main process within budget').toBeLessThanOrEqual(budget.mainGrowthMiB)
      if (source !== 'pty') expect(result.memory.mitmGrowthMiB, 'mitmdump within budget').toBeLessThanOrEqual(budget.mitmGrowthMiB)
      expect(result.spoolAtEnd.files, 'the spool drains once its project is open').toBe(0)
    } catch (e) {
      result.error = (e as Error).message.split('\n').slice(0, 5).join(' | ')
      result.appOutputTail = tail
      console.log(`[SOAK] ${result.error}`)
      throw e
    } finally {
      clearInterval(queuePoll); clearInterval(apiPoll)
      save()
      console.log(`[SOAK] results: ${out}`)
      await driver.stop().catch(() => {})
      await server.close()
      await ctx.app.close().catch(() => {})
    }
  })
}
