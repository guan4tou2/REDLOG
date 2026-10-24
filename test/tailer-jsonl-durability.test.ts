import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as host from '../src/main/services/tailer-host'
import * as events from '../src/core/db/events'
import * as db from '../src/core/db/index'
import { createOperator, generateToken } from '../src/core/db/operators'
import { claudeCodeAdapter } from '../src/main/services/adapters/claude-code'

// The JSONL tailer reads from where its sidecar ends and appends what it read
// after processing it. A turn whose write threw was reported only to capture
// health, and the sidecar advanced anyway: the turn was never read again, and
// the source looked healthy.

const h = vi.hoisted(() => ({ failOn: new Set<string>() }))

vi.mock('../src/core/ingest', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/ingest')>()
  return {
    ...real,
    ingestEvent: ((type, data, opts) => {
      const text = String((data as { full?: unknown; preview?: unknown }).full ?? (data as { preview?: unknown }).preview ?? '')
      if (h.failOn.has(text)) throw new Error('SQLITE_BUSY')
      return real.ingestEvent(type, data, opts)
    }) as typeof real.ingestEvent
  }
})

const OP = 'operator-1'
const SID = 'aaaaaaaa-bbbb-cccc-dddd-0000000durab'
let scratch: string
let source: string

const turn = (uuid: string, text: string): string => JSON.stringify({
  type: 'user', uuid, cwd: '/tmp/durable',
  message: { role: 'user', content: [{ type: 'text', text }] }
}) + '\n'

const recorded = (): string[] => events.queryEvents({ agentType: 'agent', limit: 100 })
  .filter((e) => e.data.subtype === 'user_message')
  .map((e) => String(e.data.full ?? e.data.preview ?? ''))
  .sort()
const sidecarSize = (): number => {
  try { return fs.statSync(host._sessionsForTest().get(`claude-code:${SID}`)!.sidecarPath).size } catch { return 0 }
}

beforeEach(() => {
  h.failOn.clear()
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
