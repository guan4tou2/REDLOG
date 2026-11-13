// Spec 076 T002/T003: one run of "the basic paths" through today's code, and
// what it leaves behind, as plain data.
//
// "Basic" is the list in spec FR-020's base-layer table that has to keep working
// with every extension off: shell hook events, AI tool transcripts, the
// mitmproxy addon's flow events, markers from the three places that write
// them, the screenshot shortcut, and an added artifact. Each goes through the
// code that really handles it, not around it:
//
//   shell hook      the hook's payload shape -> ingest() with the envelope
//                   POST /api/events builds (api-server.ts); the route itself
//                   is checked in basic-paths-pinned.test.ts where a port can be
//                   bound
//   AI tools        two sample transcripts (Claude Code, Codex) through
//                   tailer-host with the real adapters from optional-plugins/
//   mitmproxy       hooks/mitmproxy-addon.py's own request/response hooks on a
//                   flow shaped like mitmproxy's (fixtures/mitm-flow-payloads.py)
//                   -> the payloads it would POST -> ingest()
//   markers         ipc/markers.ts `marker:create` (IPC), the body of main's
//                   addHudMarker built from its exported parts (HUD), and a
//                   marker posted the way an outside tool does (API)
//   screenshot      ScreenshotAgent.captureNow('manual', ...) from the shortcut,
//                   and the held frame a marker claims, with electron's capture
//                   API stood in for
//   artifact_added  ipc/artifacts.ts `artifacts:add`
//
// Then the exports of those rows: the JSON envelope, NDJSON, and the bundle's
// events.jsonl / events_logged.jsonl.
//
// What is recorded per row is everything but what is allowed to differ between
// runs and between phases of this spec: the row id (aliased to its order),
// every clock value, the session, the hash/prev/signature (they cover the
// above), and data._ingest. Everything else, the columns that say which door
// and mapper wrote it, the target, the data, is kept. Clocks, ids, host name and
// signatures are fixed, so two runs give the same rows (basic-paths-pinned
// checks that), and a run with other temp directories gives the same rows too.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { vi } from 'vitest'
import { clockMock, clockControl, T_START, pythonBin } from '../fixtures/golden-pre071-generate'

export const ENG = 'eng-basic-paths'
export const OP = 'op-basic-paths'
const HOST = 'basic-paths-host'
const ROOT = path.resolve(__dirname, '..', '..')

export interface RowRecord {
  /** Which step of the run wrote it. */
  step: string
  tier: 'chained' | 'logged'
  columns: Record<string, unknown>
  data: Record<string, unknown>
}

export interface ExportRecord {
  bytes: number
  /** sha256 of the file exactly as written. Moves when a row's id, time, hash or `_ingest` moves. */
  sha256: string
  /** sha256 of the rows with the fields a phase may change removed (see normalizeEvent). Must not move. */
  normalizedSha256: string
  rows: number
}

export interface BasicPathsRun {
  rows: RowRecord[]
  rowsPerStep: Record<string, number>
  exports: {
    /** Taken after the markers and before the screenshot and artifact steps, so no row carries
     *  an absolute path and the files are the same bytes wherever the run happens. */
    early: { json: ExportRecord; ndjson: ExportRecord; bundleEvents: ExportRecord; bundleLogged: ExportRecord; bundleFiles: string[] }
    /** Taken at the end: those two rows carry the temp directory, so only the normalized digest holds. */
    final: { json: Pick<ExportRecord, 'rows' | 'normalizedSha256'>; ndjson: Pick<ExportRecord, 'rows' | 'normalizedSha256'> }
  }
}

export interface RunOptions {
  /** How the shell hook's events reach ingest(): straight in with the envelope
   *  the route builds (default), or through a real POST /api/events on a bound
   *  loopback port (needs the `listen` capability). */
  shellDoor?: 'ingest' | 'http'
  /** HOME for the run: where `~/.redlog/plugins/state.json` and friends are read from. */
  home?: string
  /** Runs after the project is open and before the first source writes, with the HOME in use. */
  beforeSources?: (home: string) => void | Promise<void>
}

const KEY_SEED_TEXT = 'RedLog basic-paths fixture operator. A public test seed, not a secret.'

/** The operator's key pair from a public seed, so the bundle's manifest (which carries the public key) is the same on every run. */
function writeOperatorKeys(keysDir: string, operatorId: string): void {
  const seed = crypto.createHash('sha256').update(KEY_SEED_TEXT).digest()
  // PKCS#8 wrapper for a raw Ed25519 seed (RFC 8410).
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed])
  const jwk = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }).export({ format: 'jwk' }) as { d: string; x: string }
  fs.mkdirSync(keysDir, { recursive: true })
  fs.writeFileSync(path.join(keysDir, `${operatorId}.key`), Buffer.from(jwk.d, 'base64url').toString('base64'), { mode: 0o600 })
  fs.writeFileSync(path.join(keysDir, `${operatorId}.pub`), Buffer.from(jwk.x, 'base64url').toString('base64'))
}

const sha256 = (b: string | Buffer): string => crypto.createHash('sha256').update(b).digest('hex')

/** Fields a later phase may change (ids, times, the hash chain over them, the
 *  ingest stamp) removed, ids inside strings aliased by order. */
const VOLATILE = ['id', 'timestamp', '@timestamp', 'createdAt', 'created_at', 'monotonicNs', 'monotonic_ns', 'ntpOffsetMs',
  'ntp_offset_ms', 'sessionId', 'session_id', 'hash', 'prevHash', 'prev_hash', 'signature', 'rowId']

export function normalizeEvent(ev: Record<string, unknown>, alias: (s: string) => string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(ev)) {
    if (VOLATILE.includes(k)) continue
    if (k === 'data' && v && typeof v === 'object') {
      const { _ingest: _dropped, ...rest } = v as Record<string, unknown>
      out.data = JSON.parse(alias(JSON.stringify(rest)))
      continue
    }
    out[k] = typeof v === 'string' ? alias(v) : v
  }
  return out
}

function digestJsonLines(text: string, alias: (s: string) => string): ExportRecord {
  const lines = text.split('\n').filter(Boolean)
  const normalized = lines.map((l) => JSON.stringify(normalizeEvent(JSON.parse(l) as Record<string, unknown>, alias)))
  return { bytes: Buffer.byteLength(text), sha256: sha256(text), normalizedSha256: sha256(normalized.join('\n')), rows: lines.length }
}

const jpegOf = (byte: number): Buffer => Buffer.alloc(64, byte)
function imageOf(byte: number): unknown {
  const img = {
    toJPEG: () => jpegOf(byte),
    toBitmap: () => Buffer.alloc(288, byte),
    isEmpty: () => false,
    getSize: () => ({ width: 100, height: 100 }),
    resize: () => img
  }
  return img
}

/** The Claude Code and Codex transcripts the AI step reads. */
function writeTranscripts(work: string): { claude: string; claudeDir: string; codex: string; codexDir: string } {
  const claudeDir = path.join(work, 'claude-projects')
  const claudeFile = path.join(claudeDir, '-work-engagement', 'aaaaaaaa-bbbb-cccc-dddd-000000000001.jsonl')
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true })
  fs.writeFileSync(claudeFile, [
    { type: 'user', uuid: 'u1', cwd: '/work/engagement', timestamp: '2026-11-13T10:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'scan the web host and summarise' }] } },
    { type: 'assistant', uuid: 'u2', parentUuid: 'u1', timestamp: '2026-11-13T10:00:02.000Z',
      message: { role: 'assistant', model: 'claude-sample', content: [{ type: 'text', text: 'Running a service scan.' }], usage: { input_tokens: 12, output_tokens: 7 } } },
    { type: 'tool_use', uuid: 'u3', parentUuid: 'u2', timestamp: '2026-11-13T10:00:03.000Z',
      message: { content: [{ type: 'tool_use', id: 'toolu_basic_1', name: 'Bash', input: { command: 'nmap -sV 10.0.0.5' } }] } },
    { type: 'tool_result', uuid: 'u4', parentUuid: 'u3', timestamp: '2026-11-13T10:00:04.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_basic_1', content: '22/tcp open ssh\n80/tcp open http' }] } }
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')

  const codexDir = path.join(work, 'codex-sessions')
  const codexFile = path.join(codexDir, '2026', '11', '13', 'rollout-2026-11-13T10-00-00-basic.jsonl')
  fs.mkdirSync(path.dirname(codexFile), { recursive: true })
  fs.writeFileSync(codexFile, [
    { timestamp: '2026-11-13T10:00:00.000Z', type: 'session_meta', payload: { cwd: '/work/engagement', id: 'codex-basic-session', model_provider: 'sample', cli_version: '0.0.0' } },
    { timestamp: '2026-11-13T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list the listening ports' }] } },
    { timestamp: '2026-11-13T10:00:02.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell_command', call_id: 'call_basic_1', arguments: '{"command":"ss -ltn","workdir":"/work/engagement"}' } },
    { timestamp: '2026-11-13T10:00:03.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_basic_1', output: 'LISTEN 0 128 0.0.0.0:22' } },
    { timestamp: '2026-11-13T10:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Port 22 is listening.' }] } }
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')
  return { claude: claudeFile, claudeDir, codex: codexFile, codexDir }
}

export async function runBasicPaths(opts: RunOptions = {}): Promise<BasicPathsRun> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-basic-paths-'))
  const home = opts.home ?? path.join(work, 'home')
  fs.mkdirSync(home, { recursive: true })
  const projectDir = path.join(work, 'project')
  const keysDir = path.join(work, 'keys')
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, keys: process.env.REDLOG_KEYS_DIR }
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.REDLOG_KEYS_DIR = keysDir

  let uuid = 0
  vi.resetModules()
  vi.spyOn(crypto, 'randomUUID').mockImplementation(() => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`)
  vi.spyOn(os, 'hostname').mockReturnValue(HOST)
  vi.useFakeTimers({ now: T_START, toFake: ['Date'] })
  clockControl.ntpOffsetMs = null
  vi.doMock('../../src/core/clock', async (importOriginal) => clockMock(await importOriginal<Record<string, unknown>>()))
  vi.doMock('../../src/core/signing', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../src/core/signing')>()
    return { ...real, signEvent: (canonical: string, operator: string) => `sig:${operator}:${sha256(canonical)}` }
  })
  let cursorDisplay = 2
  let picked: string[] = []
  vi.doMock('electron', () => ({
    screen: {
      getPrimaryDisplay: () => ({ id: 1, size: { width: 100, height: 100 } }),
      getCursorScreenPoint: () => ({ x: 5000, y: 0 }),
      getDisplayNearestPoint: () => ({ id: cursorDisplay, size: { width: 100, height: 100 } }),
      getAllDisplays: () => [{ id: 1 }, { id: 2 }]
    },
    desktopCapturer: { getSources: async () => [1, 2].map((id) => ({ display_id: String(id), thumbnail: imageOf(id * 10 + 1) })) },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: picked }) },
    shell: { showItemInFolder: () => undefined, openExternal: async () => undefined }
  }))

  try {
    const db = await import('../../src/core/db/index')
    const events = await import('../../src/core/db/events')
    const ops = await import('../../src/core/db/operators')
    const ingestMod = await import('../../src/core/ingest')
    const redaction = await import('../../src/core/redaction')
    const config = await import('../../src/core/config')
    void config

    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'config.yaml'), `engagement:\n  id: ${ENG}\noperator:\n  id: ${OP}\n`)
    db.initDB(projectDir)
    db.bindDBEngagement(ENG)
    ingestMod._resetIngest()
    redaction.configureRedaction({ denylist: [] })
    writeOperatorKeys(keysDir, OP)
    ops.createOperator({ id: OP, name: 'Basic Paths Operator', token: ['basic', 'paths', 'operator'].join('-'), isPrimary: true })
    const who = { engagementId: ENG, operatorId: OP }
    const step = (): void => { vi.advanceTimersByTime(1000) }

    await opts.beforeSources?.(home)

    const marks: Array<{ step: string; chained: number; logged: number }> = []
    const count = (table: string): number => (db.getDB().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    const mark = (name: string): void => { marks.push({ step: name, chained: count('events'), logged: count('events_logged') }) }

    const API = { source: 'api', mapper: { id: 'identity', version: '1' } }
    const post = (agentType: string, data: Record<string, unknown>, targetId?: string): string | null => {
      step()
      const r = ingestMod.ingest({ agentType, data, ...who, ...(targetId ? { targetId } : {}), envelope: API })
      return r.event?.id ?? null
    }
    let apiBase = ''
    let apiToken = ''
    let apiMod: typeof import('../../src/core/api-server') | null = null
    if (opts.shellDoor === 'http') {
      apiMod = await import('../../src/core/api-server')
      apiMod.configureApi({ engagementId: ENG, operatorId: OP, operatorName: 'Basic Paths Operator' })
      apiBase = `http://127.0.0.1:${await apiMod.startApiServer(0)}`
      apiMod.onApiProjectOpen()
      apiToken = apiMod.getApiToken()
    }
    /** The shell hook's door: POST /api/events when asked to, else the same ingest() call the route makes. */
    const shellPost = async (data: Record<string, unknown>, targetId?: string): Promise<string | null> => {
      if (!apiMod) return post('shell', data, targetId)
      step()
      const res = await fetch(`${apiBase}/api/events`, {
        method: 'POST', headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_type: 'shell', data, ...(targetId ? { target_id: targetId } : {}) })
      })
      if (res.status !== 201) throw new Error(`POST /api/events answered ${res.status}: ${await res.text()}`)
      return (await res.json() as { id: string }).id
    }

    // 1. shell hook, as zsh and bash post it.
    mark('start')
    await shellPost({ subtype: 'command_start', command: 'nmap -sV 10.0.0.5', shell: 'zsh', pid: 4101, terminalId: 'term-zsh-1', command_id: 'c-zsh-1', cwd: '/work/engagement', source_timestamp: Date.now() })
    const firstEnd = await shellPost({ subtype: 'command_end', command: 'nmap -sV 10.0.0.5', shell: 'zsh', pid: 4101, terminalId: 'term-zsh-1', command_id: 'c-zsh-1', cwd: '/work/engagement', exit_code: 0,
      stdout: '22/tcp open ssh\n80/tcp open http\n', output_started_at: Date.now() - 400, source_timestamp: Date.now() })
    await shellPost({ subtype: 'command_start', command: 'curl -si http://10.0.0.5/login', shell: 'bash', pid: 4202, terminalId: 'term-bash-1', command_id: 'c-bash-1', cwd: '/work/engagement', source_timestamp: Date.now() }, '10.0.0.5')
    await shellPost({ subtype: 'command_end', command: 'curl -si http://10.0.0.5/login', shell: 'bash', pid: 4202, terminalId: 'term-bash-1', command_id: 'c-bash-1', cwd: '/work/engagement', exit_code: 22,
      stdout: 'HTTP/1.1 404 Not Found\n', source_timestamp: Date.now() }, '10.0.0.5')
    mark('shell-hook')

    // 2-3. AI tool transcripts through the host and the real adapters.
    const tailer = await import('../../src/main/services/tailer-host')
    const claudeAdapter = (await import('../../optional-plugins/claude-code/adapter')).claudeCodeAdapter
    const codexMod = await import('../../optional-plugins/codex/adapter')
    const files = writeTranscripts(work)
    claudeAdapter.transcriptGlob = path.join(files.claudeDir, '**', '*.jsonl')
    codexMod.overrideCodexTranscriptRoot(files.codexDir)
    tailer.registerAdapter(claudeAdapter)
    tailer.registerAdapter(codexMod.codexAdapter)
    step()
    // An idle flush is a real timer: an hour keeps it from firing in the middle of the run.
    tailer.configureHost({ enabled: true, identity: { projectId: 'proj-basic', engagementId: ENG, operatorId: OP },
      claudeProjectsDir: files.claudeDir, idleFlushMs: 3_600_000, previewChars: 100, emitThinking: false } as never)
    tailer.registerSession('claude-code', files.claude)
    mark('ai-claude-code')
    step()
    tailer.registerSession('codex', files.codex)
    mark('ai-codex')

    // 4. mitmproxy addon: its own hooks, its own payloads.
    step()
    const pyHome = path.join(work, 'py-home')
    fs.mkdirSync(pyHome, { recursive: true })
    const flow = spawnSync(pythonBin, ['-I', path.join(__dirname, 'fixtures', 'mitm-flow-payloads.py'), path.join(ROOT, 'hooks', 'mitmproxy-addon.py'), String(Date.now() / 1000)],
      { encoding: 'utf8', env: { ...process.env, HOME: pyHome, USERPROFILE: pyHome }, timeout: 20_000 })
    if (flow.status !== 0) throw new Error(`mitmproxy addon fixture failed (${flow.status}): ${flow.stderr}`)
    for (const p of JSON.parse(flow.stdout) as Array<{ agent_type: string; data: Record<string, unknown>; target_id?: string }>) post(p.agent_type, p.data, p.target_id)
    mark('mitmproxy-flow')

    // 5. marker, IPC: what the Inspector and the quick-mark form call.
    const markers = await import('../../src/main/ipc/markers')
    const handlers = new Map<string, (...a: unknown[]) => unknown>()
    const proj = { id: ENG, name: 'Basic paths', path: projectDir, createdAt: 1, lastOpened: 1 }
    const ctx = { getActiveProject: () => proj, getMainWindow: () => ({}) } as never
    const fakeIpc = { handle: (name: string, fn: (...a: unknown[]) => unknown) => handlers.set(name, fn) } as never
    const shotAgentMod = await import('../../src/main/services/screenshot-agent')
    const agent = new shotAgentMod.ScreenshotAgent(() => ({ state: 'ok' }) as never)
    agent.configure({ identity: { projectId: 'proj-basic', engagementId: ENG, operatorId: OP } })
    markers.registerMarkersIpc(fakeIpc, ctx, agent)
    step()
    const ipcMarker = handlers.get('marker:create')!({}, { title: 'SSH exposed', notes: 'open on 10.0.0.5', severity: 'high', category: 'finding', causes: firstEnd ? [firstEnd] : [], targetId: '10.0.0.5' }) as { id: string } | null
    mark('marker-ipc')

    // 6. marker, HUD: addHudMarker in main/index.ts is not importable; this is its body from its exported parts.
    step()
    for (const input of [{ title: 'login page reached', notes: 'via form', at: Date.now() - 3000 }, { at: Date.now() - 1000 }]) {
      const f = markers.hudMarkerFields(input, Date.now())
      events.insertEvent('marker', redaction.redactFields({
        title: f.title, notes: f.notes, severity: 'info', category: 'custom', source_timestamp: f.source_timestamp, source: f.source
      }, markers.MARKER_TEXT_FIELDS), who)
      step()
    }
    mark('marker-hud')

    // 7. marker, API: an outside tool posting one.
    post('marker', { subtype: 'finding', title: 'Default credentials page', notes: 'reported by a script', severity: 'medium', category: 'custom' }, '10.0.0.5')
    mark('marker-api')

    // Exports of the rows so far, byte for byte. The bundle writes two rows of its own into the chain.
    const ndjsonMod = await import('../../src/core/ndjson-export')
    const redactMod = await import('../../src/core/redact-export')
    const fileMod = await import('../../src/core/export-events-file')
    const bundleMod = await import('../../src/core/bundle-export')
    /** The JSON envelope and NDJSON of `all`, with their digests. */
    const exportRows = (all: ReturnType<typeof events.queryEvents>, alias: (s: string) => string, label: string): { json: ExportRecord; ndjson: ExportRecord } => {
      const ndjson = ndjsonMod.eventsToNdjson(all)
      const jsonPath = path.join(work, `events-${label}.json`)
      const fd = fs.openSync(jsonPath, 'w')
      const writer = new fileMod.EventFileWriter(fd, 'json', { config: {}, exportedAt: '2026-11-13T10:00:00.000Z', exportPlan: { id: 'plan-basic', fingerprint: 'fp-basic' } }, false)
      for (const e of redactMod.redactEventsForExport(all, {})) writer.row(e)
      writer.end()
      fs.closeSync(fd)
      const jsonText = fs.readFileSync(jsonPath, 'utf8')
      const doc = JSON.parse(jsonText) as { events: Array<Record<string, unknown>> }
      return {
        json: {
          bytes: Buffer.byteLength(jsonText), sha256: sha256(jsonText), rows: doc.events.length,
          normalizedSha256: sha256(doc.events.map((e) => JSON.stringify(normalizeEvent(e, alias))).join('\n'))
        },
        ndjson: digestJsonLines(ndjson, alias)
      }
    }
    step()
    const earlyAll = events.queryEvents({ limit: -1 })
    const earlyIds = new Map(earlyAll.map((e, i) => [e.id, `<row ${i}>`] as const))
    const earlyAlias = (t: string): string => { let o = t; for (const [id, a] of earlyIds) o = o.split(id).join(a); return o }
    const earlyRows = exportRows(earlyAll, earlyAlias, 'early')
    const bundle = bundleMod.exportBundle(ENG, { outRoot: path.join(work, 'bundles') })
    const listFiles = (dir: string, rel = ''): string[] => fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
      .flatMap((e) => e.isDirectory() ? listFiles(dir, `${rel}${e.name}/`) : [`${rel}${e.name}`]).sort()
    const readBundle = (name: string): string => fs.readFileSync(path.join(bundle.outDir, name), 'utf8')
    const early = {
      ...earlyRows,
      // events.jsonl is read after the bundle's own rows were appended; its first lines are the rows above.
      bundleEvents: digestJsonLines(readBundle('events.jsonl'), earlyAlias),
      bundleLogged: digestJsonLines(readBundle('events_logged.jsonl'), earlyAlias),
      bundleFiles: listFiles(bundle.outDir)
    }
    mark('export-early')

    // The AI sessions end: each writes a transcript snapshot whose path is under the temp directory.
    tailer.stopHost()
    mark('ai-session-end')

    // 8. screenshot: the shortcut, then a frame held for a marker to claim.
    step()
    await agent.captureNow('manual', undefined, { hideOwnWindows: true })
    step()
    const token = await agent.holdFrame()
    step()
    await agent.captureNow('manual', ipcMarker?.id, { heldFrame: token ?? undefined, hideOwnWindows: true })
    mark('screenshot-hotkey')

    // 9. artifact_added.
    const artifactsMod = await import('../../src/main/ipc/artifacts')
    artifactsMod.registerArtifactsIpc(fakeIpc, ctx)
    const loot = path.join(work, 'loot', 'notes.txt')
    fs.mkdirSync(path.dirname(loot), { recursive: true })
    fs.writeFileSync(loot, 'credentials page screenshot notes\n')
    fs.utimesSync(loot, new Date(T_START - 60_000), new Date(T_START - 60_000))
    picked = [loot]
    step()
    await (handlers.get('artifacts:add')!({}, 'Add evidence') as Promise<unknown>)
    mark('artifact-added')

    // What the run wrote, in the order it was written.
    const raw: Array<{ step: string; tier: 'chained' | 'logged'; row: Record<string, unknown> }> = []
    for (const tier of ['chained', 'logged'] as const) {
      const table = tier === 'chained' ? 'events' : 'events_logged'
      const all = db.getDB().prepare(`SELECT rowid AS _rowid, * FROM ${table} ORDER BY rowid`).all() as Array<Record<string, unknown>>
      all.forEach((row, index) => {
        const bucket = marks.slice(1).find((m, i) => index < m[tier === 'chained' ? 'chained' : 'logged'] && index >= marks[i][tier === 'chained' ? 'chained' : 'logged'])
        raw.push({ step: bucket?.step ?? 'after-last-step', tier, row })
      })
    }
    const ids = new Map<string, string>()
    raw.forEach((r, i) => ids.set(String(r.row.id), `<row ${i}>`))
    const dirs = [...new Set([work, fs.realpathSync(work), os.tmpdir()])]
    const scrub = (s: string): string => {
      let out = s
      for (const [id, alias] of ids) out = out.split(id).join(alias)
      // Longest first, JSON-escaped (Windows) form before the plain one.
      for (const dir of dirs.sort((a, b) => b.length - a.length)) out = out.split(dir.replace(/\\/g, '\\\\')).join('<tmp>').split(dir).join('<tmp>')
      // The rest of a path under the temp dir: one separator on every platform.
      return out.replace(/<tmp>[^"]*/g, (m) => m.replace(/\\\\/g, '/'))
    }
    const rows: RowRecord[] = raw.map(({ step: s, tier, row }) => {
      const { _rowid: _r, ...cols } = row
      const data = JSON.parse(String(cols.data)) as Record<string, unknown>
      delete cols.data
      const normalized = normalizeEvent({ ...cols, data }, scrub)
      const { data: nd, ...columns } = normalized
      // A bare HUD mark is titled with the local time of day.
      const d = nd as Record<string, unknown>
      if (typeof d.title === 'string' && /^HUD mark /.test(d.title)) d.title = 'HUD mark <time of day>'
      return { step: s, tier, columns, data: d }
    })
    const rowsPerStep: Record<string, number> = {}
    for (const r of rows) rowsPerStep[r.step] = (rowsPerStep[r.step] ?? 0) + 1

    // Exports of every row, at the end: normalized only (see BasicPathsRun.exports.final).
    const lastExports = exportRows(events.queryEvents({ limit: -1 }), scrub, 'final')
    const pick = (r: ExportRecord): { rows: number; normalizedSha256: string } => ({ rows: r.rows, normalizedSha256: r.normalizedSha256 })
    const final = { json: pick(lastExports.json), ndjson: pick(lastExports.ndjson) }

    apiMod?.stopApiServer()
    ;(await import('../../src/core/http-body-index')).closeHttpBodyIndex()
    db.getDB().pragma('wal_checkpoint(TRUNCATE)')
    db.closeDB()
    return { rows, rowsPerStep, exports: { early, final } }
  } finally {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.doUnmock('../../src/core/clock')
    vi.doUnmock('../../src/core/signing')
    vi.doUnmock('electron')
    vi.resetModules()
    for (const [k, v] of Object.entries({ HOME: prev.HOME, USERPROFILE: prev.USERPROFILE, REDLOG_KEYS_DIR: prev.keys })) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fs.rmSync(work, { recursive: true, force: true })
  }
}
