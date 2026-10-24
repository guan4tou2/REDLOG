import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as host from '../src/main/services/tailer-host'
import * as events from '../src/core/db/events'
import * as db from '../src/core/db/index'
import { createOperator, generateToken } from '../src/core/db/operators'
import { claudeCodeAdapter } from '../src/main/services/adapters/claude-code'
import { eventBus } from '../src/core/event-bus'

// The JSONL tailer reads from where its sidecar ends and appends what it read
// after processing it. A turn whose write threw was reported only to capture
// health, and the sidecar advanced anyway: the turn was never read again, and
// the source looked healthy.

const h = vi.hoisted(() => ({ failOn: new Set<string>(), failAll: false }))

vi.mock('../src/core/ingest', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/ingest')>()
  return {
    ...real,
    ingestEvent: ((type, data, opts) => {
      const text = String((data as { full?: unknown; preview?: unknown }).full ?? (data as { preview?: unknown }).preview ?? '')
      if (h.failOn.has(text) || (h.failAll && type === 'agent')) throw new Error('SQLITE_BUSY')
      return real.ingestEvent(type, data, opts)
    }) as typeof real.ingestEvent
  }
})

const OP = 'operator-1'
const SID = 'aaaaaaaa-bbbb-cccc-dddd-0000000durab'
let scratch: string
let source: string

const turn = (uuid: string, text: string, parentUuid: string | null = null): string => JSON.stringify({
  type: 'user', uuid, parentUuid, cwd: '/tmp/durable',
  message: { role: 'user', content: [{ type: 'text', text }] }
}) + '\n'

const recorded = (): string[] => events.queryEvents({ agentType: 'agent', limit: 100 })
  .filter((e) => e.data.subtype === 'user_message')
  .map((e) => String(e.data.full ?? e.data.preview ?? ''))
  .sort()
const sidecarSize = (): number => {
  try { return fs.statSync(host._sessionsForTest().get(`claude-code:${SID}`)!.sidecarPath).size } catch { return 0 }
}

const gaps = (): Array<Record<string, unknown>> => events.queryEvents({ agentType: 'system', limit: 20 })
  .filter((e) => e.data.subtype === 'capture_gap').map((e) => e.data)

beforeEach(() => {
  h.failOn.clear()
  h.failAll = false
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tailer-jsonl-'))
  db.initDB(scratch)
  createOperator({ id: OP, name: 'Operator 1', token: generateToken() })
  const dir = path.join(scratch, 'claude-projects', '-tmp-durable')
  fs.mkdirSync(dir, { recursive: true })
  source = path.join(dir, `${SID}.jsonl`)
  claudeCodeAdapter.transcriptGlob = path.join(scratch, 'claude-projects', '**', '*.jsonl')
  host.registerAdapter(claudeCodeAdapter)
  host.configureHost({ enabled: true, engagementId: 'e1', operatorId: OP, idleFlushMs: 60_000, previewChars: 1000 })
})

afterEach(() => {
  if (eventBus.paused) eventBus.resume()
  host.stopHost()
  vi.useRealTimers()
  try { db.closeDB() } catch { /* ignore */ }
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('a transcript turn whose write fails', () => {
  it('holds the sidecar back, and is written once on the next pass', () => {
    fs.writeFileSync(source, turn('u1', 'first') + turn('u2', 'second'))
    h.failOn.add('second')
    host.registerSession('claude-code', source)
    expect(recorded()).toEqual(['first'])
    expect(sidecarSize()).toBe(0)

    h.failOn.clear()
    host.catchUpSession('claude-code', SID)
    // `first` landed the first time and is not written again.
    expect(recorded()).toEqual(['first', 'second'])
    expect(sidecarSize()).toBe(fs.statSync(source).size)
  })

  it('is retried on its own when the transcript does not change again', async () => {
    vi.useFakeTimers()
    fs.writeFileSync(source, turn('u1', 'last words'))
    h.failOn.add('last words')
    host.registerSession('claude-code', source)
    expect(recorded()).toEqual([])

    h.failOn.clear()
    await vi.advanceTimersByTimeAsync(1000)
    expect(recorded()).toEqual(['last words'])
  })

  it('is given up after the bounded retries, says so, and does not hold back what follows', async () => {
    vi.useFakeTimers()
    fs.writeFileSync(source, turn('u1', 'never'))
    h.failOn.add('never')
    host.registerSession('claude-code', source)
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    const gap = events.queryEvents({ agentType: 'system', limit: 10 }).find((e) => e.data.subtype === 'capture_gap')
    expect(gap?.data).toMatchObject({ reason: 'write_failed', failed_turns: 1 })
    expect(sidecarSize()).toBe(fs.statSync(source).size)

    fs.appendFileSync(source, turn('u2', 'next'))
    host.catchUpSession('claude-code', SID)
    expect(recorded()).toEqual(['next'])
  })
})

describe('a turn with nothing left to re-read', () => {
  it('is kept when it was a queued child whose flush failed', async () => {
    vi.useFakeTimers()
    // The child arrives first and waits; the sidecar moves past it.
    fs.writeFileSync(source, turn('c', 'child', 'p'))
    host.registerSession('claude-code', source)
    fs.appendFileSync(source, turn('p', 'parent'))
    h.failOn.add('child')
    host.catchUpSession('claude-code', SID)
    h.failOn.clear()
    await vi.advanceTimersByTimeAsync(1000)
    expect(recorded()).toEqual(['child', 'parent'])
    expect(gaps()).toEqual([])
  })

  it('is written after a pause that began before its retry', async () => {
    vi.useFakeTimers()
    fs.writeFileSync(source, turn('u1', 'pre-pause work'))
    h.failOn.add('pre-pause work')
    host.registerSession('claude-code', source)
    h.failOn.clear()
    eventBus.pause()
    await vi.advanceTimersByTimeAsync(5000)
    eventBus.resume()
    await vi.advanceTimersByTimeAsync(1000)
    expect(recorded()).toEqual(['pre-pause work'])
  })
})

describe('the retry budget', () => {
  it('is spent by the retry timer, not by a burst of file events', async () => {
    vi.useFakeTimers()
    fs.writeFileSync(source, turn('u1', 'busy'))
    h.failOn.add('busy')
    host.registerSession('claude-code', source)
    // Four file events. Counted as retries they would push the next one out
    // to 16 s; the timer's own schedule says 1 s.
    for (let i = 0; i < 4; i++) host.catchUpSession('claude-code', SID)
    h.failOn.clear()
    await vi.advanceTimersByTimeAsync(1000)
    expect(recorded()).toEqual(['busy'])
    expect(gaps()).toEqual([])
  })

  it('starts over for a failure after a recovery', async () => {
    vi.useFakeTimers()
    fs.writeFileSync(source, turn('u1', 'a'))
    h.failOn.add('a')
    host.registerSession('claude-code', source)
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 8000)
    h.failOn.clear()
    await vi.advanceTimersByTimeAsync(16_000)
    expect(recorded()).toEqual(['a'])

    fs.appendFileSync(source, turn('u2', 'b'))
    h.failOn.add('b')
    host.catchUpSession('claude-code', SID)
    h.failOn.clear()
    // A spent budget would give up on the first retry instead of writing it.
    await vi.advanceTimersByTimeAsync(1000)
    expect(recorded()).toEqual(['a', 'b'])
    expect(gaps()).toEqual([])
  })

  it('does not fire for a session the host has let go', async () => {
    vi.useFakeTimers()
    fs.writeFileSync(source, turn('u1', 'orphaned'))
    h.failOn.add('orphaned')
    host.registerSession('claude-code', source)
    host.stopHost()
    h.failOn.clear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(recorded()).toEqual([])
  })
})

describe('a re-read after a failed pass', () => {
  it('counts each tool call once', () => {
    fs.writeFileSync(source, JSON.stringify({
      type: 'tool_use', uuid: 't1', cwd: '/tmp/durable',
      message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'id' } }] }
    }) + '\n')
    h.failAll = true
    host.registerSession('claude-code', source)
    h.failAll = false
    host.catchUpSession('claude-code', SID)
    const s = host._sessionsForTest().get(`claude-code:${SID}`)!
    expect(s.toolCallsEmitted).toBe(1)
    expect(s.toolCallsSeen).toBe(1)
  })
})

describe('a child waiting for a parent that has not arrived', () => {
  it('waits once, however often a failed pass is read again', () => {
    fs.writeFileSync(source, turn('c', 'orphan child', 'never') + turn('x', 'x'))
    h.failOn.add('x')
    host.registerSession('claude-code', source)
    host.catchUpSession('claude-code', SID)
    host.catchUpSession('claude-code', SID)
    expect(host._sessionsForTest().get(`claude-code:${SID}`)!.pendingByParentUuid.get('never')).toHaveLength(1)
  })
})

describe('a thinking turn', () => {
  it('whose write fails is held back like any other', () => {
    host.configureHost({ enabled: true, engagementId: 'e1', operatorId: OP, idleFlushMs: 60_000, emitThinking: true })
    db.getDB().exec('ALTER TABLE events_logged RENAME TO events_logged_gone')
    fs.writeFileSync(source, JSON.stringify({
      type: 'assistant', uuid: 'th1', cwd: '/tmp/durable',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'a plan' }] }
    }) + '\n')
    host.registerSession('claude-code', source)
    expect(sidecarSize()).toBe(0)
    db.getDB().exec('ALTER TABLE events_logged_gone RENAME TO events_logged')
    host.catchUpSession('claude-code', SID)
    expect(sidecarSize()).toBe(fs.statSync(source).size)
  })
})

describe('a transcript started before AI capture was turned on', () => {
  it('re-reads a failed turn from after the base, not from the start', () => {
    fs.writeFileSync(source, turn('old', 'before activation'))
    host.configureHost({ enabled: true, engagementId: 'e1', operatorId: OP, idleFlushMs: 60_000, previewChars: 1000, activationStarts: { 'claude-code': Date.now() + 1000 } })
    host.registerSession('claude-code', source)
    fs.appendFileSync(source, turn('u1', 'first') + turn('u2', 'second'))
    h.failOn.add('second')
    host.catchUpSession('claude-code', SID)
    h.failOn.clear()
    host.catchUpSession('claude-code', SID)
    expect(recorded()).toEqual(['first', 'second'])
  })
})
