// Spec 071 T004 (US6): what each installed producer does with each answer
// POST /api/events can give it. Recorded against a mock server, with each
// producer's own sending code, unmodified.
//
// The answers are the ones test/api-events-legacy-mapping.test.ts records the
// real route giving. The producers decide from the status and, for two of them,
// the error text — never from what actually happened — and they decide
// differently. This table is the "legacy" side of the receipt contract later
// phases introduce (01-capture-integrity.md F1); it is what an installed hook
// that has not been re-sourced keeps doing after an upgrade.
//
// What the decisions mean, as observed:
//   done          the producer considers it delivered and keeps nothing
//   nothing       it keeps nothing, records nothing, retries nothing — for a
//                 non-2xx answer that is a loss nobody can see
//   spool         the full payload is written to ~/.redlog/pending for replay
//   gap           a content-free system.capture_gap record is spooled instead
//   drop-counted  the bytes are added to the relay's dropped_bytes (final row)
//   drop-logged   dropped, with one line on the producer's stderr
//   retry         kept in memory and sent again later
//
// Known defects are `it.fails`, each naming its finding; flip them to `it` in
// the change that fixes them. One cell of the audit's table does NOT
// reproduce and is pinned as it is (RELAY_5XX).
//
// Runtimes: bash for the shell hook (POSIX only — counted as skipped on
// Windows), python3 for relay/mitm/pcap-agent (test/fixtures/
// legacy-producer-decision.py), node for the two plugins (their send
// functions are lifted out of the script with the TypeScript parser, since the
// scripts start capturing at load), pwsh for redlog-send.ps1.

import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { requires } from './helpers/requires'

const ROOT = path.resolve(__dirname, '..')
const listen = requires('listen')
const posix = requires('posix-shell')
const python = requires('python-cryptography')
const pwsh = requires('pwsh')
const pythonBin = process.platform === 'win32' ? 'python' : 'python3'

type Response = 'accepted' | 'paused' | 'unrecorded' | 'duplicate' | 'engagement' | 'policy' | 'malformed' | 'unauthorized' | 'noProject' | 'internal' | 'unreachable'

/** The real route's answers, from test/api-events-legacy-mapping.test.ts. */
const ANSWERS: Record<Exclude<Response, 'unreachable'>, [number, unknown]> = {
  accepted: [201, { id: '00000000-0000-4000-8000-000000000001', agentType: 'shell', tier: 'chained' }],
  paused: [200, { ok: true, recording: false, skipped: 'recording paused' }],
  unrecorded: [200, { ok: true, recording: false, skipped: 'terminal not recording' }],
  duplicate: [409, { error: 'Duplicate event (dedup window)' }],
  engagement: [409, { error: 'engagement changed; session capture refused' }],
  policy: [403, { error: 'agent_type "system" is not allowed via external API' }],
  malformed: [400, { error: 'data must be a JSON object' }],
  unauthorized: [401, { error: 'Unauthorized. Set Authorization: Bearer <token>' }],
  noProject: [503, { error: 'No project open. Open a project in the RedLog UI first.' }],
  internal: [500, { error: 'internal error' }]
}
const RESPONSES = [...Object.keys(ANSWERS), 'unreachable'] as Response[]

// ── The mock app ────────────────────────────────────────────────────────────

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

interface Mock { port: number; requests: Array<{ url: string; body: string }> }

async function mock(response: Response): Promise<Mock> {
  const requests: Mock['requests'] = []
  if (response === 'unreachable') {
    // A port that was free a moment ago and has nothing listening now.
    const s = net.createServer()
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
    const port = (s.address() as net.AddressInfo).port
    await new Promise<void>((resolve) => s.close(() => resolve()))
    return { port, requests }
  }
  const [status, body] = ANSWERS[response]
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      requests.push({ url: req.url ?? '', body: raw })
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { port: (server.address() as net.AddressInfo).port, requests }
}

/** A home with .redlog/{api-port,api-token,active-identity.json}. */
function home(port: number | null): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-legacy-producer-'))
  cleanups.push(() => fs.rmSync(h, { recursive: true, force: true }))
  fs.mkdirSync(path.join(h, '.redlog'))
  fs.writeFileSync(path.join(h, '.redlog', 'api-token'), 'legacy-test-token')
  fs.writeFileSync(path.join(h, '.redlog', 'active-identity.json'), JSON.stringify({ engagementId: 'eng-legacy', operatorId: 'op-legacy' }))
  if (port !== null) fs.writeFileSync(path.join(h, '.redlog', 'api-port'), String(port))
  return h
}

function run(cmd: string, args: string[], env: Record<string, string>, timeoutMs = 20_000): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Asynchronous: the mock server lives in this process.
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (c) => { stdout += String(c) })
    child.stderr.on('data', (c) => { stderr += String(c) })
    child.on('close', (status) => { clearTimeout(killer); resolve({ status, stdout, stderr }) })
  })
}

const spooledIn = (h: string): string[] => {
  const dir = path.join(h, '.redlog', 'pending')
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : []
}

// ── Producers ───────────────────────────────────────────────────────────────

type Decision = 'done' | 'nothing' | 'spool' | 'gap' | 'drop-counted' | 'drop-logged' | 'retry'

/** hooks/shell-common.sh `_redlog_send_event`, as bash and zsh source it. */
async function shell(response: Response): Promise<Decision> {
  const m = await mock(response)
  const h = home(m.port)
  const script = path.join(h, 'run.sh')
  fs.writeFileSync(script, [
    'set -u',
    `source ${JSON.stringify(path.join(ROOT, 'hooks', 'shell-common.sh'))}`,
    "_redlog_send_event command_start 'id'",
    'echo "UNSAVED=${_REDLOG_UNSAVED:-}"'
  ].join('\n') + '\n')
  const r = await run('bash', [script], { HOME: h, _REDLOG_DIR: path.join(h, '.redlog'), _REDLOG_HOST: '127.0.0.1' })
  expect(r.status, r.stderr).toBe(0)
  if (response !== 'unreachable') expect(m.requests, 'the hook must have posted').toHaveLength(1)
  return spooledIn(h).length > 0 ? 'spool' : 'nothing'
}

async function py(producer: 'relay' | 'mitm' | 'pcap-agent', response: Response | 'no-port'): Promise<Record<string, unknown>> {
  const m = response === 'no-port' ? null : await mock(response)
  const h = home(m ? m.port : null)
  const r = await run(pythonBin, [path.join(ROOT, 'test', 'fixtures', 'legacy-producer-decision.py'), producer, h, m ? String(m.port) : 'none'], { HOME: h })
  expect(r.status, r.stderr).toBe(0)
  // The answer under test was actually given.
  if (m && response !== 'unreachable') expect(m.requests.length, `${producer} must have posted`).toBeGreaterThan(0)
  return JSON.parse(r.stdout) as Record<string, unknown>
}

/** hooks/redlog-relay.py LateOutput: one `_send`, then the same payload class through `retry()`. */
async function relay(response: Response): Promise<Decision> {
  const out = await py('relay', response) as { verdict: string; dropped_bytes: number; pending: number; spooled: string[] }
  expect(out.spooled, 'the relay never spools').toEqual([])
  const decision: Decision = out.pending > 0 ? 'retry' : out.dropped_bytes > 0 ? 'drop-counted' : 'done'
  // The verdict behind it, so a change of reason is visible too.
  const verdict = { done: 'accepted', 'drop-counted': ['paused', 'unrecorded'].includes(response) ? 'paused' : 'refused', retry: 'failed' }[decision as 'done']
  expect(out.verdict).toBe(verdict)
  return decision
}

/** hooks/mitmproxy-addon.py `_send_to_redlog` and the delivery it queues. */
async function mitm(response: Response): Promise<Decision> {
  const out = await py('mitm', response) as { admitted: boolean; spooled: string[] }
  expect(out.admitted).toBe(true)
  if (out.spooled.length === 0) return 'nothing'
  expect(out.spooled, 'the addon spools a gap, never the content').toEqual(['capture_gap'])
  return 'gap'
}

/** hooks/pcap-agent.py `_send_to_redlog`. */
async function pcapAgent(response: Response | 'no-port'): Promise<Decision> {
  const out = await py('pcap-agent', response) as { spooled: string[] }
  if (out.spooled.length === 0) return 'nothing'
  expect(out.spooled).toEqual(['connection_attempt'])
  return 'spool'
}

/** Top-level function declarations of a plugin script, by name, as source. */
function liftJs(file: string, names: string[]): string {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
  const found = new Map<string, string>()
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && names.includes(st.name.text)) found.set(st.name.text, st.getText(sf))
  }
  const missing = names.filter((n) => !found.has(n))
  if (missing.length) throw new Error(`${file}: ${missing.join(', ')} not found`)
  return names.map((n) => found.get(n)).join('\n')
}

/** plugins/c2-tailers/c2-tail.js `post`, with its real postOutcome. */
async function c2(response: Response): Promise<Decision> {
  const m = await mock(response)
  const h = home(m.port)
  const stderr: string[] = []
  const nodeRequire = createRequire(path.join(ROOT, 'plugins', 'c2-tailers', 'c2-tail.js'))
  const { postOutcome } = nodeRequire('./follow.js') as { postOutcome: (s: number) => string }
  const make = new Function('fs', 'portFile', 'tokenFile', 'postOutcome', 'process', 'fetch',
    `${liftJs('plugins/c2-tailers/c2-tail.js', ['redlogConn', 'post'])}\nreturn post`)
  const post = make(fs, path.join(h, '.redlog', 'api-port'), path.join(h, '.redlog', 'api-token'), postOutcome,
    { stderr: { write: (s: string) => { stderr.push(s) } } }, fetch) as (ev: unknown) => Promise<string>
  const outcome = await post({ agent_type: 'agent', data: { subtype: 'c2_task', framework: 'generic', command: 'whoami' } })
  if (response !== 'unreachable') expect(m.requests).toHaveLength(1)
  if (outcome === 'ok') { expect(stderr).toEqual([]); return 'done' }
  if (outcome === 'drop') { expect(stderr.join('')).toContain('RedLog refused'); return 'drop-logged' }
  expect(outcome).toBe('retry')
  return 'retry'
}

/** plugins/pcap-capture/pcap-capture.js `post`. Every caller ignores what it
 *  returns but for a `posted` counter (`if (await post(f)) posted++`), so a
 *  false is a flow nobody will see again. */
async function pcapCapture(response: Response): Promise<Decision> {
  const m = await mock(response)
  const h = home(m.port)
  const make = new Function('fs', 'portFile', 'tokenFile', 'fetch',
    `${liftJs('plugins/pcap-capture/pcap-capture.js', ['conn', 'post'])}\nreturn post`)
  const post = make(fs, path.join(h, '.redlog', 'api-port'), path.join(h, '.redlog', 'api-token'), fetch) as (d: unknown) => Promise<boolean>
  const ok = await post({ subtype: 'flow_summary', dst_ip: '10.0.0.9', dst_port: 22 })
  if (response !== 'unreachable') expect(m.requests).toHaveLength(1)
  expect(spooledIn(h)).toEqual([])
  return ok ? 'done' : 'nothing'
}

// ── Today's table ───────────────────────────────────────────────────────────

/** 01-capture-integrity.md F1 says the relay retries 5xx. It does not: any
 *  HTTPError other than the 409 dedup text is `refused` and its bytes are
 *  dropped (redlog-relay.py `_send`); only a network error is `failed`. */
const RELAY_5XX: Decision = 'drop-counted'

const TODAY: Record<string, Record<Response, Decision>> = {
  shell: {
    accepted: 'nothing', paused: 'nothing', unrecorded: 'nothing', duplicate: 'spool', engagement: 'spool', policy: 'spool',
    malformed: 'spool', unauthorized: 'spool', noProject: 'spool', internal: 'spool', unreachable: 'spool'
  },
  relay: {
    accepted: 'done', paused: 'drop-counted', unrecorded: 'drop-counted', duplicate: 'done', engagement: 'drop-counted',
    policy: 'drop-counted', malformed: 'drop-counted', unauthorized: 'drop-counted', noProject: RELAY_5XX, internal: RELAY_5XX, unreachable: 'retry'
  },
  mitm: {
    accepted: 'nothing', paused: 'nothing', unrecorded: 'nothing', duplicate: 'nothing', engagement: 'nothing', policy: 'nothing',
    malformed: 'nothing', unauthorized: 'nothing', noProject: 'gap', internal: 'gap', unreachable: 'gap'
  },
  'pcap-agent': {
    accepted: 'nothing', paused: 'nothing', unrecorded: 'nothing', duplicate: 'spool', engagement: 'spool', policy: 'spool',
    malformed: 'spool', unauthorized: 'spool', noProject: 'spool', internal: 'spool', unreachable: 'spool'
  },
  c2: {
    accepted: 'done', paused: 'done', unrecorded: 'done', duplicate: 'drop-logged', engagement: 'drop-logged', policy: 'drop-logged',
    // As 01-F1 says: postOutcome retries 401, 408, 429 and every 5xx.
    malformed: 'drop-logged', unauthorized: 'retry', noProject: 'retry', internal: 'retry', unreachable: 'retry'
  },
  'pcap-capture': {
    accepted: 'done', paused: 'done', unrecorded: 'done', duplicate: 'nothing', engagement: 'nothing', policy: 'nothing',
    malformed: 'nothing', unauthorized: 'nothing', noProject: 'nothing', internal: 'nothing', unreachable: 'nothing'
  }
}

/** Known defects: [producer, response] → the finding and what the fixed
 *  producer does instead. Each is an `it.fails` until the fix lands. */
const DEFECTS: Array<{ producer: string; response: Response; finding: string; check: (d: Decision) => void }> = [
  { producer: 'shell', response: 'duplicate', finding: '01-F1(b): a 409 dedup is spooled in full and the replay, outside the 2 s window, writes it a second time',
    check: (d) => expect(d).not.toBe('spool') },
  { producer: 'shell', response: 'policy', finding: '01-F1 migration step 4 / T007: a refusal is spooled in full, and the spool drain does not apply the API policy',
    check: (d) => expect(d).not.toBe('spool') },
  { producer: 'shell', response: 'malformed', finding: '01-F1 migration step 4: a 400 is spooled in full and replayed through ingest unchanged',
    check: (d) => expect(d).not.toBe('spool') },
  { producer: 'pcap-agent', response: 'duplicate', finding: '01-F1 table: pcap-agent spools a 409 dedup in full, as the shell does (F1(b))',
    check: (d) => expect(d).not.toBe('spool') },
  { producer: 'mitm', response: 'policy', finding: '01-F1(d): a 4xx refusal is neither replayed nor recorded as a gap',
    check: (d) => expect(d).toBe('gap') },
  // A 409 dedup is not a loss (the event is recorded), so `duplicate → nothing`
  // stays a pin; every refused or failed answer is.
  ...(['engagement', 'policy', 'malformed', 'unauthorized', 'noProject', 'internal', 'unreachable'] as Response[]).map((response) => ({
    producer: 'pcap-capture', response,
    finding: 'T004 (corrects 01-F1): pcap-capture ignores what post returns, so a refused or failed flow is lost without trace',
    check: (d: Decision) => expect(d).not.toBe('nothing')
  }))
]
const isDefect = (producer: string, response: Response): boolean => DEFECTS.some((d) => d.producer === producer && d.response === response)

const PRODUCERS: Record<string, { cap: ReturnType<typeof requires>; decide: (r: Response) => Promise<Decision> }> = {
  shell: { cap: posix, decide: shell },
  relay: { cap: python, decide: relay },
  mitm: { cap: python, decide: mitm },
  'pcap-agent': { cap: python, decide: pcapAgent },
  c2: { cap: listen, decide: c2 },
  'pcap-capture': { cap: listen, decide: pcapCapture }
}

listen.describe('legacy producers × /api/events answers', () => {
  for (const [producer, { cap, decide }] of Object.entries(PRODUCERS)) {
    describe(producer, () => {
      for (const response of RESPONSES) {
        if (isDefect(producer, response)) continue
        cap.it(`${response} → ${TODAY[producer][response]}`, async () => {
          expect(await decide(response)).toBe(TODAY[producer][response])
        })
      }
      for (const d of DEFECTS.filter((x) => x.producer === producer)) {
        // `it.fails` on the capability's `it`, so an absent runtime skips it.
        cap.it.fails(`${d.response}: ${d.finding}`, async () => {
          d.check(await decide(d.response))
        })
      }
    })
  }

  // 01-F3 item 4: with no api-port file the agent returns before it would
  // spool, so an event captured while RedLog is closed is gone without trace.
  python.it.fails('pcap-agent with no api-port file keeps the event for replay (01-F3 item 4)', async () => {
    expect(await pcapAgent('no-port')).toBe('spool')
  })

  // hooks/redlog-send.ps1 posts from a background runspace inside `try {} catch {}`
  // and keeps nothing, whatever the answer. Right for an answer that recorded
  // the event (or already had it); for a refused or failed one it is known
  // defect 01-F3 item 4, the swallowed refusal recorded nowhere.
  const PS_DONE: Response[] = ['accepted', 'paused', 'unrecorded', 'duplicate']
  const PS_LOST: Response[] = ['engagement', 'policy', 'malformed', 'unauthorized', 'noProject', 'internal', 'unreachable']

  pwsh.it(`redlog-send.ps1 keeps nothing and says nothing for ${PS_DONE.join(', ')}`, async () => {
    const r = await powershell(PS_DONE)
    expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ status: 0, stdout: '', stderr: '' })
    expect(r.kept).toEqual(Object.fromEntries(PS_DONE.map((x) => [x, []])))
  }, 90_000)

  pwsh.it.fails('redlog-send.ps1 keeps a record of each refused or failed event (01-F3 item 4: `catch {}` swallows it)', async () => {
    const r = await powershell(PS_LOST)
    expect(r.status, r.stderr).toBe(0)
    expect(PS_LOST.filter((x) => r.kept[x].length === 0)).toEqual([])
  }, 90_000)
})

/** One pwsh session sends one event per answer, each from its own home (the
 *  sender reads its home when dot-sourced, so it is dot-sourced again for
 *  each), and waits for all of them to arrive. `kept` is what each home holds
 *  under .redlog beyond the three files `home()` put there. */
async function powershell(responses: Response[]): Promise<{ status: number | null; stdout: string; stderr: string; kept: Record<string, string[]> }> {
  const sender = path.join(ROOT, 'hooks', 'redlog-send.ps1')
  const runDir = home(null)
  const homes = new Map<Response, { m: Mock; h: string }>()
  const lines: string[] = []
  for (const r of responses) {
    const m = await mock(r)
    const h = home(m.port)
    homes.set(r, { m, h })
    lines.push(`$env:USERPROFILE = '${h.replace(/'/g, "''")}'`)
    lines.push(`. '${sender.replace(/'/g, "''")}'`)
    lines.push(`Send-RedLogEvent 'echo ${r}' command_start`)
    // Each runspace reads nothing back, so give it time to send before the
    // next one starts.
    lines.push('Start-Sleep -Milliseconds 300')
  }
  lines.push('Start-Sleep -Seconds 3')
  const script = path.join(runDir, 'send.ps1')
  fs.writeFileSync(script, lines.join('\n') + '\n')
  const r = await run('pwsh', ['-NoProfile', '-NonInteractive', '-File', script], { USERPROFILE: runDir, HOME: runDir }, 60_000)
  // Every answer was actually given, so "keeps nothing" is not vacuous.
  const received = responses.filter((x) => x !== 'unreachable' && homes.get(x)!.m.requests.length === 1)
  expect(received).toEqual(responses.filter((x) => x !== 'unreachable'))
  const seeded = ['active-identity.json', 'api-port', 'api-token']
  const kept = Object.fromEntries(responses.map((x) => [x,
    fs.readdirSync(path.join(homes.get(x)!.h, '.redlog')).filter((f) => !seeded.includes(f)).sort()]))
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim(), kept }
}
