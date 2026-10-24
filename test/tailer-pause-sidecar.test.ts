import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { claudeCodeAdapter } from '../src/main/services/adapters/claude-code'
import { registerAdapter, configureHost, registerSession, catchUpSession, stopHost, _sessionsForTest } from '../src/main/services/tailer-host'
import { eventBus } from '../src/core/event-bus'
import { initDB, closeDB } from '../src/core/db/index'
import { queryEvents } from '../src/core/db/events'
import { createOperator, generateToken } from '../src/core/db/operators'

// Pausing says the stretch is not part of the record. The tailer stopped
// writing events during a pause but went on appending the transcript's raw
// bytes to its own sidecar, so the private conversation was kept on disk all
// the same. It now keeps none of those bytes, and resume must not read them
// back in either: the sidecar's size is also where the next read starts.

const OP = 'operator-1'
const SID = 'aaaaaaaa-bbbb-cccc-dddd-00000000p0se'
let scratch: string
let source: string

const turn = (uuid: string, text: string): string => JSON.stringify({
  type: 'user', uuid, cwd: '/tmp/pause',
  message: { role: 'user', content: [{ type: 'text', text }] }
}) + '\n'

const sidecar = (): string => fs.readFileSync(_sessionsForTest().get(`claude-code:${SID}`)!.sidecarPath, 'utf-8')
const recorded = (): string[] => queryEvents({ agentType: 'agent', limit: 100 })
  .filter((e) => e.data.subtype === 'user_message')
  .map((e) => String(e.data.full ?? e.data.preview ?? ''))
  .sort()

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tailer-pause-'))
  initDB(scratch)
  createOperator({ id: OP, name: 'Operator 1', token: generateToken() })
  const dir = path.join(scratch, 'claude-projects', '-tmp-pause')
  fs.mkdirSync(dir, { recursive: true })
  source = path.join(dir, `${SID}.jsonl`)
  claudeCodeAdapter.transcriptGlob = path.join(scratch, 'claude-projects', '**', '*.jsonl')
  registerAdapter(claudeCodeAdapter)
  configureHost({ enabled: true, engagementId: 'e1', operatorId: OP, idleFlushMs: 60_000, previewChars: 1000 })
})

afterEach(() => {
  if (eventBus.paused) eventBus.resume()
  stopHost()
  try { closeDB() } catch { /* ignore */ }
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('an AI transcript read while recording is paused', () => {
  it('leaves nothing of the paused turns in RedLog, and resume does not record them', () => {
    fs.writeFileSync(source, turn('u1', 'before the pause'))
    registerSession('claude-code', source)

    eventBus.pause()
    fs.appendFileSync(source, turn('u2', 'PRIVATE-CONVERSATION'))
    catchUpSession('claude-code', SID)
    eventBus.resume()

    fs.appendFileSync(source, turn('u3', 'after the pause'))
    catchUpSession('claude-code', SID)

    expect(recorded()).toEqual(['after the pause', 'before the pause'])
    expect(sidecar()).not.toContain('PRIVATE-CONVERSATION')
    // The sidecar still marks how far the source was read.
    expect(fs.statSync(_sessionsForTest().get(`claude-code:${SID}`)!.sidecarPath).size).toBe(fs.statSync(source).size)
    const gap = queryEvents({ agentType: 'system', limit: 10 }).find((e) => e.data.subtype === 'capture_gap')
    expect(gap?.data.skipped_lines).toBe(1)
  })

  it('drops a line that began during the pause and finished after it', () => {
    fs.writeFileSync(source, turn('u1', 'before'))
    registerSession('claude-code', source)

    const straddling = turn('u2', 'STARTED-WHILE-PAUSED and finished later')
    const half = Math.floor(straddling.length / 2)
    eventBus.pause()
    fs.appendFileSync(source, straddling.slice(0, half))
    catchUpSession('claude-code', SID)
    eventBus.resume()

    fs.appendFileSync(source, straddling.slice(half) + turn('u3', 'after'))
    catchUpSession('claude-code', SID)

    expect(recorded()).toEqual(['after', 'before'])
    expect(sidecar()).not.toContain('STARTED-WHILE-PAUSED')
    expect(sidecar()).not.toContain('finished later')
  })

  it('does not read the pause back in after a restart', () => {
    fs.writeFileSync(source, turn('u1', 'before'))
    registerSession('claude-code', source)
    eventBus.pause()
    fs.appendFileSync(source, turn('u2', 'PRIVATE-CONVERSATION'))
    catchUpSession('claude-code', SID)
    eventBus.resume()

    // A restart: the host forgets the session and registers it from disk.
    stopHost()
    registerAdapter(claudeCodeAdapter)
    configureHost({ enabled: true, engagementId: 'e1', operatorId: OP, idleFlushMs: 60_000, previewChars: 1000 })
    fs.appendFileSync(source, turn('u3', 'after'))
    registerSession('claude-code', source)

    expect(recorded()).toEqual(['after', 'before'])
  })
})

describe('a line that began during the pause', () => {
  const restart = (): void => {
    stopHost()
    registerAdapter(claudeCodeAdapter)
    configureHost({ enabled: true, engagementId: 'e1', operatorId: OP, idleFlushMs: 60_000, previewChars: 1000 })
  }

  it('is still dropped when the rest arrives after a restart', () => {
    fs.writeFileSync(source, turn('u1', 'before'))
    registerSession('claude-code', source)
    const straddling = turn('u2', 'PRIVATE-START xxxxxxxxxxxxxxxxxxxxxxxx PRIVATE-END')
    const half = straddling.indexOf('xxxx')
    eventBus.pause()
    fs.appendFileSync(source, straddling.slice(0, half))
    catchUpSession('claude-code', SID)
    eventBus.resume()

    restart()
    fs.appendFileSync(source, straddling.slice(half) + turn('u3', 'after'))
    registerSession('claude-code', source)

    expect(recorded()).toEqual(['after', 'before'])
    expect(sidecar()).not.toContain('PRIVATE-END')
  })

  it('does not take the first line of a transcript compacted after the pause', () => {
    fs.writeFileSync(source, turn('u1', 'before'))
    registerSession('claude-code', source)
    eventBus.pause()
    fs.appendFileSync(source, turn('u2', 'PRIVATE half').slice(0, 20))
    catchUpSession('claude-code', SID)
    eventBus.resume()

    fs.writeFileSync(source, turn('c1', 'after compaction'))
    catchUpSession('claude-code', SID)
    expect(recorded()).toContain('after compaction')
  })

  it('leaves no mark that outlives a pruned sidecar', () => {
    fs.writeFileSync(source, turn('u1', 'before'))
    registerSession('claude-code', source)
    eventBus.pause()
    fs.appendFileSync(source, turn('u2', 'PRIVATE half').slice(0, 20))
    catchUpSession('claude-code', SID)
    eventBus.resume()
    const sidecarPath = _sessionsForTest().get(`claude-code:${SID}`)!.sidecarPath

    // Retention removes the sidecar; the source is then read from the start.
    restart()
    fs.rmSync(sidecarPath)
    fs.writeFileSync(source, turn('n1', 'first line'))
    registerSession('claude-code', source)
    expect(recorded()).toContain('first line')
  })
})

describe('a CRLF transcript', () => {
  it('keeps nothing of a paused line', () => {
    fs.writeFileSync(source, turn('u1', 'before'))
    registerSession('claude-code', source)
    eventBus.pause()
    fs.appendFileSync(source, turn('u2', 'PRIVATE').replace('\n', '\r\n'))
    catchUpSession('claude-code', SID)
    eventBus.resume()
    fs.appendFileSync(source, turn('u3', 'after').replace('\n', '\r\n'))
    catchUpSession('claude-code', SID)
    expect(recorded()).toEqual(['after', 'before'])
    expect(sidecar()).not.toContain('PRIVATE')
  })
})

describe('a transcript started before AI capture was turned on', () => {
  // Capture reads from the activation point, so the sidecar holds only what
  // came after it and the read position is that base plus the sidecar's size.
  it('keeps nothing of a pause read after the base, and resumes from the right place', () => {
    fs.writeFileSync(source, turn('old', 'before activation'))
    const startedAt = Date.now() + 1000
    configureHost({ enabled: true, engagementId: 'e1', operatorId: OP, idleFlushMs: 60_000, previewChars: 1000, activationStarts: { 'claude-code': startedAt } })
    registerSession('claude-code', source)

    eventBus.pause()
    fs.appendFileSync(source, turn('u2', 'PRIVATE-CONVERSATION'))
    catchUpSession('claude-code', SID)
    eventBus.resume()
    fs.appendFileSync(source, turn('u3', 'after the pause'))
    catchUpSession('claude-code', SID)

    expect(recorded()).toEqual(['after the pause'])
    expect(sidecar()).not.toContain('PRIVATE-CONVERSATION')
    expect(sidecar()).not.toContain('before activation')
  })
})
