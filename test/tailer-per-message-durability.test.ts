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
  parsed: [] as string[],
  gaps: [] as Array<Record<string, unknown>>
}))

vi.mock('../src/core/ingest', () => ({
  ingestEvent: (_type: string, data: { subtype?: string; full?: string; preview?: string }) => {
    if (data.subtype === 'capture_gap') h.gaps.push(data as Record<string, unknown>)
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
      const m = JSON.parse(raw) as { id: string; text: string; parent?: string }
      h.parsed.push(m.id)
      return { uuid: m.id, parentUuid: m.parent ?? null, type: 'user', role: 'user', textContent: m.text }
    },
    subtypeFor: () => 'user_message'
  }
}

const message = (name: string, text: string, parent?: string, mtime?: number): void => {
  const file = path.join(sessionDir, name)
  fs.writeFileSync(file, JSON.stringify({ id: name.replace('.json', ''), text, parent }))
  if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000)
}

const index = (): string[] => {
  const file = path.join(scratch, 'agent-transcripts', `${AGENT}-ses_1.jsonl`)
  try { return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean) } catch { return [] }
}

beforeEach(async () => {
  vi.resetModules()
  h.written.length = 0
  h.parsed.length = 0
  h.gaps.length = 0
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

  it('gives up after the bounded retries, says so, and stops trying', async () => {
    vi.useFakeTimers()
    message('msg_a.json', 'never')
    h.failOn.add('never')
    let attempts = 0
    const real = h.failOn.has.bind(h.failOn)
    h.failOn.has = (t: string) => { if (t === 'never') attempts++; return real(t) }
    host.registerSession(AGENT, sessionDir)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(h.gaps).toEqual([expect.objectContaining({ reason: 'write_failed', failed_turns: 1 })])
    expect(index()).toEqual(['msg_a.json'])
    const settled = attempts
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(attempts).toBe(settled)
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

describe('a turn with nothing left to re-read', () => {
  it('is kept when it was a queued child whose flush failed', () => {
    const t = Date.now() - 10_000
    // The child's file is older, so it is read first and waits for its parent.
    message('msg_b.json', 'child', 'msg_a', t)
    message('msg_a.json', 'parent', undefined, t + 1000)
    h.failOn.add('child')
    host.registerSession(AGENT, sessionDir)
    h.failOn.clear()
    host.catchUpSession(AGENT, 'ses_1')
    expect(h.written.sort()).toEqual(['child', 'parent'])
  })

  it('is written after a pause that began before its retry', async () => {
    vi.useFakeTimers()
    message('msg_a.json', 'pre-pause')
    h.failOn.add('pre-pause')
    host.registerSession(AGENT, sessionDir)
    h.failOn.clear()
    h.paused = true
    await vi.advanceTimersByTimeAsync(5000)
    h.paused = false
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.written).toEqual(['pre-pause'])
  })
})

describe('a per-message file that never parses', () => {
  it('is given up after the retries and recorded as unread', async () => {
    vi.useFakeTimers()
    fs.writeFileSync(path.join(sessionDir, 'msg_junk.json'), 'not json')
    host.registerSession(AGENT, sessionDir)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(index()).toEqual(['msg_junk.json'])
    expect(h.gaps).toEqual([expect.objectContaining({ reason: 'write_failed', unparsed_units: 1 })])
    const parses = h.parsed.length
    message('msg_ok.json', 'ok')
    host.catchUpSession(AGENT, 'ses_1')
    expect(h.written).toEqual(['ok'])
    expect(h.parsed.length).toBe(parses + 1)
  })
})
