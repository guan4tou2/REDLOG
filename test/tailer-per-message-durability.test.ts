import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// A per-message source (OpenCode's layout) writes one file per message, and
// the host keeps an index of the file names it has handled. That index used to
// be written before the file's events: a write that failed, or a file read
// before its writer finished, was marked done and never read again. The source
// looked healthy and the message was simply not in the record.

const h = vi.hoisted(() => ({
  written: [] as string[],
  failOn: new Set<string>(),
  paused: false,
  n: 0,
  parsed: [] as string[]
}))

vi.mock('../src/core/ingest', () => ({
  ingestEvent: (_type: string, data: { subtype?: string; full?: string; preview?: string }) => {
    if (data.subtype !== 'user_message') return { id: `meta-${++h.n}` }
    const text = String(data.full ?? data.preview ?? '')
    if (h.failOn.has(text)) throw new Error('SQLITE_BUSY')
    h.written.push(text)
    return { id: `ev-${++h.n}` }
  }
}))
vi.mock('../src/core/event-bus', () => ({ eventBus: { get paused() { return h.paused }, on: () => {}, off: () => {} } }))
vi.mock('../src/core/capture-health', () => ({ noteDbError: () => {} }))

let scratch: string
let sessionDir: string
let host: typeof import('../src/main/services/tailer-host')
let db: typeof import('../src/core/db/index')

const AGENT = 'fake-per-message'

function adapter(root: string): import('../src/main/services/tailer-host').TailerAdapter {
  return {
    agentKind: AGENT,
    transcriptGlob: path.join(root, '*', '*.json'),
    perMessageDir: true,
    knownIngestTypes: new Set(['user']),
    knownIgnoredTypes: new Set(),
    resolveCwd: () => scratch,
    parseUnit: (raw: string) => {
      const m = JSON.parse(raw) as { id: string; text: string }
      h.parsed.push(m.id)
      return { uuid: m.id, parentUuid: null, type: 'user', role: 'user', textContent: m.text }
    },
    subtypeFor: () => 'user_message'
  }
}

const message = (name: string, text: string): void =>
  fs.writeFileSync(path.join(sessionDir, name), JSON.stringify({ id: name.replace('.json', ''), text }))

const index = (): string[] => {
  const file = path.join(scratch, 'agent-transcripts', `${AGENT}-ses_1.jsonl`)
  try { return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean) } catch { return [] }
}

beforeEach(async () => {
  vi.resetModules()
  h.written.length = 0
  h.parsed.length = 0
  h.failOn.clear()
  h.paused = false
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tailer-pm-'))
  const root = path.join(scratch, 'messages')
  sessionDir = path.join(root, 'ses_1')
  fs.mkdirSync(sessionDir, { recursive: true })
  db = await import('../src/core/db/index')
  db.initDB(scratch)
  host = await import('../src/main/services/tailer-host')
  host.registerAdapter(adapter(root))
  host.configureHost({ enabled: true, engagementId: 'e1', operatorId: 'op', enabledAgents: [AGENT], idleFlushMs: 60_000 })
})

afterEach(() => {
  host.stopHost()
  vi.useRealTimers()
  try { db.closeDB() } catch { /* ignore */ }
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('a per-message file whose events did not land', () => {
  it('is not indexed, and is written on the next pass', () => {
    message('msg_a.json', 'first')
    message('msg_b.json', 'second')
    h.failOn.add('second')
    host.registerSession(AGENT, sessionDir)
    expect(h.written).toEqual(['first'])
    expect(index()).toEqual(['msg_a.json'])

    h.failOn.clear()
    host.catchUpSession(AGENT, 'ses_1')
    expect(h.written).toEqual(['first', 'second'])
    expect(index()).toEqual(['msg_a.json', 'msg_b.json'])
  })

  it('is retried on its own when the directory does not change again', async () => {
    vi.useFakeTimers()
    message('msg_a.json', 'last words')
    h.failOn.add('last words')
    host.registerSession(AGENT, sessionDir)
    expect(h.written).toEqual([])

    h.failOn.clear()
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.written).toEqual(['last words'])
  })

  it('is read again when it was caught mid-write', () => {
    fs.writeFileSync(path.join(sessionDir, 'msg_a.json'), '{"id":"msg_a","te')
    host.registerSession(AGENT, sessionDir)
    expect(index()).toEqual([])

    message('msg_a.json', 'finished')
    host.catchUpSession(AGENT, 'ses_1')
    expect(h.written).toEqual(['finished'])
    expect(index()).toEqual(['msg_a.json'])
  })

  it('stops retrying after a bounded number of attempts', async () => {
    vi.useFakeTimers()
    message('msg_a.json', 'never')
    h.failOn.add('never')
    let attempts = 0
    const real = h.failOn.has.bind(h.failOn)
    h.failOn.has = (t: string) => { if (t === 'never') attempts++; return real(t) }
    host.registerSession(AGENT, sessionDir)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    // The first pass, then five retries.
    expect(attempts).toBe(6)
  })
})

describe('a handled per-message file', () => {
  it('is not read again on later passes', () => {
    message('msg_a.json', 'once')
    host.registerSession(AGENT, sessionDir)
    host.catchUpSession(AGENT, 'ses_1')
    host.catchUpSession(AGENT, 'ses_1')
    expect(h.parsed).toEqual(['msg_a'])
  })

  it('is indexed unread while paused, and not recorded on resume', () => {
    host.registerSession(AGENT, sessionDir)
    h.paused = true
    message('msg_a.json', 'private')
    host.catchUpSession(AGENT, 'ses_1')
    h.paused = false
    message('msg_b.json', 'work')
    host.catchUpSession(AGENT, 'ses_1')
    expect(h.written).toEqual(['work'])
    expect(index()).toEqual(['msg_a.json', 'msg_b.json'])
  })
})
