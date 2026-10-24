import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
vi.mock('fs', async original => ({ ...await original<typeof import('fs')>() }))
import os from 'node:os'
import path from 'node:path'
import * as ingestion from '../src/core/ingest'
import { getCaptureError, clearCaptureError } from '../src/core/capture-health'
import { eventBus } from '../src/core/event-bus'
import { initDB, closeDB } from '../src/core/db/index'
import { queryEvents } from '../src/core/db/events'
import { createOperator, generateToken } from '../src/core/db/operators'
import { registerAdapter, unregisterAdapter, configureHost, stopHost, registerSession, catchUpSession, listAgentSessions, _sessionsForTest } from '../src/main/services/tailer-host'
import type { TailerAdapter } from '../src/main/services/tailer-host'

let dir: string, source: string
const adapter: TailerAdapter = {
  agentKind: 'durability-fixture', transcriptGlob: '/nonexistent/redlog-durability/*.jsonl',
  knownIngestTypes: new Set(['user']), knownIgnoredTypes: new Set(['metadata']),
  resolveCwd: () => '/work/client', parseUnit: raw => JSON.parse(raw), subtypeFor: () => 'user_message'
}
const cfg = { enabled: true, engagementId: 'e1', operatorId: 'op', idleFlushMs: 60_000 }
const line = (uuid: string, text = uuid) => JSON.stringify({ uuid, type: 'user', textContent: text }) + '\n'
const rows = () => queryEvents({ agentType: 'agent', limit: 100 }).filter(e => e.data.transcript_uuid)
const sidecars = () => fs.existsSync(path.join(dir, 'agent-transcripts')) ? fs.readdirSync(path.join(dir, 'agent-transcripts')).filter(n => n.endsWith('.jsonl')).map(n => fs.readFileSync(path.join(dir, 'agent-transcripts', n), 'utf8')).join('') : ''
function start(perMessage = false) {
  registerAdapter({ ...adapter, perMessageDir: perMessage })
  configureHost(cfg)
  registerSession(adapter.agentKind, source)
}
function restart(perMessage = false) { stopHost(); start(perMessage) }
const catchUp = () => catchUpSession(adapter.agentKind, path.basename(source, path.extname(source)))
beforeEach(() => {
  clearCaptureError('agent-' + adapter.agentKind)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailer-durable-'))
  source = path.join(dir, 'fixture.jsonl')
  configureHost({ enabled: false, watchPathsByAgent: undefined, activationStarts: undefined, excludedSessionsByAgent: undefined, sessionStartsByAgent: undefined })
  initDB(dir); createOperator({ id: 'op', name: 'Fixture', token: generateToken() }); eventBus.resume()
})
afterEach(() => { vi.restoreAllMocks(); stopHost(); unregisterAdapter(adapter.agentKind); eventBus.resume(); closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

describe('AI capture durable progress and privacy boundaries', () => {
  it('does not commit JSONL progress when one event fails, and retries without duplicates after restart', () => {
    fs.writeFileSync(source, line('one') + line('two'))
    const real = ingestion.ingestEvent
    const fail = vi.spyOn(ingestion, 'ingestEvent').mockImplementation((kind, data, options) => {
      if (data.transcript_uuid === 'two') throw new Error('injected DB write refusal')
      return real(kind, data, options)
    })
    start(); expect(rows().map(e => e.data.transcript_uuid)).toEqual(['one'])
    expect(sidecars()).not.toContain('two')
    fail.mockRestore(); restart(); catchUp()
    expect(rows().map(e => e.data.transcript_uuid).sort()).toEqual(['one', 'two'])
  })

  it('retries a per-message unit when its event write fails, rather than seeding it as seen', () => {
    source = path.join(dir, 'session'); fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, 'msg.json'), line('message'))
    const real = ingestion.ingestEvent
    const fail = vi.spyOn(ingestion, 'ingestEvent').mockImplementation((kind, data, options) => {
      if (data.transcript_uuid) throw new Error('injected DB write refusal')
      return real(kind, data, options)
    })
    start(true); expect(rows()).toHaveLength(0); expect(sidecars()).toBe('')
    fail.mockRestore(); restart(true)
    expect(rows().map(e => e.data.transcript_uuid)).toEqual(['message'])
  })

  it('does not corrupt a partial JSONL unit when sidecar append fails', () => {
    fs.writeFileSync(source, line('one')); start()
    const complete = line('two', '中文🙂 split payload')
    fs.appendFileSync(source, complete.slice(0, 22)); catchUp()
    const real = fs.appendFileSync
    const fail = vi.spyOn(fs, 'appendFileSync').mockImplementation((file, data, options) => {
      if (String(file).includes('agent-transcripts')) throw new Error('injected sidecar write refusal')
      return real(file, data, options)
    })
    fs.appendFileSync(source, complete.slice(22)); catchUp()
    expect(fail).toHaveBeenCalled(); fail.mockRestore(); catchUp(); restart(); catchUp()
    expect(rows().map(e => e.data.transcript_uuid).sort()).toEqual(['one', 'two'])
    expect(sidecars()).toBe(line('one') + complete)
  })

  it('saves no paused raw text and does not replay it after resume or restart, even without a watcher tick', () => {
    fs.writeFileSync(source, line('before')); start()
    eventBus.pause('ui'); fs.appendFileSync(source, line('private', 'PAUSED_PRIVATE_SENTINEL'))
    // Resume must establish a boundary even if the coalesced watcher did not run.
    eventBus.resume('ui'); fs.appendFileSync(source, line('after')); catchUp(); restart(); catchUp()
    expect(sidecars()).not.toContain('PAUSED_PRIVATE_SENTINEL')
    expect(rows().map(e => e.data.transcript_uuid).sort()).toEqual(['after', 'before'])
    expect(queryEvents({ agentType: 'system', limit: 100 }).some(e => e.data.subtype === 'capture_gap')).toBe(true)
  })

  it('does not replay the end of a line that crossed a pause boundary', () => {
    fs.writeFileSync(source, line('before')); start()
    const privateLine = line('private', 'CROSS_PAUSE_PRIVATE')
    fs.appendFileSync(source, privateLine.slice(0, 15)); catchUp()
    eventBus.pause(); fs.appendFileSync(source, privateLine.slice(15, 30)); catchUp(); eventBus.resume()
    fs.appendFileSync(source, privateLine.slice(30) + line('after')); catchUp(); restart(); catchUp()
    expect(sidecars()).toBe(line('before') + line('after'))
    expect(rows().map(e => e.data.transcript_uuid).sort()).toEqual(['after', 'before'])
  })
  it('does not commit source progress after a failed checkpoint rename', () => {
    fs.writeFileSync(source, line('one')); start()
    const real = fs.renameSync
    const fail = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('.offset.json')) throw new Error('injected checkpoint refusal')
      return real(from, to)
    })
    fs.appendFileSync(source, line('two')); catchUp()
    expect(sidecars()).toBe(line('one'))
    expect(getCaptureError('agent-' + adapter.agentKind)?.message).toContain('checkpoint refusal')
    fail.mockRestore(); restart(); catchUp()
    expect(getCaptureError('agent-' + adapter.agentKind)).toBeUndefined()
    expect(sidecars()).toBe(line('one') + line('two'))
    expect(rows().map(e => e.data.transcript_uuid).sort()).toEqual(['one', 'two'])
  })

  it('does not seed a per-message filename after a failed raw-index append', () => {
    source = path.join(dir, 'session'); fs.mkdirSync(source)
    const real = fs.appendFileSync
    const fail = vi.spyOn(fs, 'appendFileSync').mockImplementation((file, data, options) => {
      if (String(file).includes('agent-transcripts')) throw new Error('injected index refusal')
      return real(file, data, options)
    })
    fs.writeFileSync(path.join(source, 'msg.json'), line('message')); start(true)
    fail.mockRestore(); restart(true)
    expect(sidecars()).toBe('msg.json\n')
    expect(rows().map(e => e.data.transcript_uuid)).toEqual(['message'])
  })

  it('respects a persisted paused boundary when reopening after a shutdown', () => {
    fs.writeFileSync(source, line('before')); start()
    eventBus.pause(); fs.appendFileSync(source, line('private', 'PRIVATE_DURING_SHUTDOWN')); stopHost()
    eventBus.resume(); start(); fs.appendFileSync(source, line('after')); catchUp()
    expect(sidecars()).toBe(line('before') + line('after'))
    expect(rows().map(e => e.data.transcript_uuid).sort()).toEqual(['after', 'before'])
  })

  it('does not parse paused per-message files, and does not recover them on restart', () => {
    source = path.join(dir, 'session'); fs.mkdirSync(source); start(true)
    eventBus.pause(); fs.writeFileSync(path.join(source, 'private.json'), line('private', 'PRIVATE_PER_MESSAGE'))
    eventBus.resume(); restart(true)
    fs.writeFileSync(path.join(source, 'after.json'), line('after')); fs.utimesSync(path.join(source, 'after.json'), new Date(Date.now() + 10), new Date(Date.now() + 10)); catchUpSession(adapter.agentKind, 'session')
    expect(rows().map(e => e.data.transcript_uuid)).toEqual(['after'])
    expect(sidecars()).not.toContain('PRIVATE_PER_MESSAGE')
  })

  it('excludes one provider session and only captures new content after reauthorization', () => {
    fs.writeFileSync(source, line('before')); start()
    const first = listAgentSessions().find(s => s.sessionId === 'fixture')!
    expect(first).toMatchObject({ agentKind: adapter.agentKind, recording: true, cwd: '/work/client' })
    configureHost({ ...cfg, excludedSessionsByAgent: { [adapter.agentKind]: ['fixture'] } })
    fs.appendFileSync(source, line('private'))
    registerSession(adapter.agentKind, source); catchUp()
    expect(listAgentSessions().find(s => s.sessionId === 'fixture')).toMatchObject({ recording: false })
    expect(rows().map(e => e.data.transcript_uuid)).toEqual(['before'])
    configureHost({ ...cfg, excludedSessionsByAgent: {}, sessionStartsByAgent: { [adapter.agentKind]: { fixture: Date.now() + 1 } } })
    registerSession(adapter.agentKind, source); fs.appendFileSync(source, line('after')); catchUp()
    expect(rows().map(e => e.data.transcript_uuid).sort()).toEqual(['after', 'before'])
    expect(sidecars()).not.toContain('private')
  })

  it('restores a pending child from retained raw evidence when the parent arrives after restart', () => {
    const child = JSON.stringify({ uuid: 'child', parentUuid: 'parent', type: 'user', textContent: 'child first' }) + '\n'
    fs.writeFileSync(source, child); start(); expect(rows()).toHaveLength(0)
    restart(); fs.appendFileSync(source, line('parent')); catchUp()
    const saved = rows(); expect(saved.map(e => e.data.transcript_uuid).sort()).toEqual(['child', 'parent'])
    expect(saved.find(e => e.data.transcript_uuid === 'child')!.data._causes).toEqual([saved.find(e => e.data.transcript_uuid === 'parent')!.id])
  })

  it('keeps a new child after pause without inventing a cause for an omitted parent', () => {
    fs.writeFileSync(source, line('before')); start(); eventBus.pause()
    fs.appendFileSync(source, line('private')); eventBus.resume()
    fs.appendFileSync(source, JSON.stringify({ uuid: 'after', parentUuid: 'private', type: 'user', textContent: 'after' }) + '\n'); catchUp()
    const saved = rows(); expect(saved.map(e => e.data.transcript_uuid).sort()).toEqual(['after', 'before'])
    expect(saved.find(e => e.data.transcript_uuid === 'after')!.data._causes).toBeUndefined()
  })

  it('links through deliberately ignored metadata instead of indefinitely buffering the next reply', () => {
    fs.writeFileSync(source, line('prompt') + JSON.stringify({ type: 'metadata', uuid: 'attachment', parentUuid: 'prompt' }) + '\n' + JSON.stringify({ type: 'user', uuid: 'reply', parentUuid: 'attachment', textContent: 'reply' }) + '\n')
    start()
    const saved = rows(); expect(saved.map(e => e.data.transcript_uuid).sort()).toEqual(['prompt', 'reply'])
    expect(saved.find(e => e.data.transcript_uuid === 'reply')!.data._causes).toEqual([saved.find(e => e.data.transcript_uuid === 'prompt')!.id])
    expect(saved.find(e => e.data.transcript_uuid === 'reply')!.data.transcript_parent_uuid).toBe('attachment')
  })

  it('omits a conversation created during pause even when discovery happens after resume', () => {
    fs.writeFileSync(source, line('before')); start(); eventBus.pause()
    const later = path.join(dir, 'later.jsonl'); fs.writeFileSync(later, line('private', 'NEW_SESSION_WHILE_PAUSED'))
    eventBus.resume(); registerSession(adapter.agentKind, later)
    fs.appendFileSync(later, line('after')); catchUpSession(adapter.agentKind, 'later')
    expect(sidecars()).not.toContain('NEW_SESSION_WHILE_PAUSED')
    expect(rows().map(e => e.data.transcript_uuid).sort()).toEqual(['after', 'before'])
  })

  it('does not acknowledge a half-written per-message file and retries its later complete write', () => {
    source = path.join(dir, 'session'); fs.mkdirSync(source)
    const file = path.join(source, 'message.json'); fs.writeFileSync(file, '{')
    start(true); expect(sidecars()).toBe('')
    fs.writeFileSync(file, line('completed')); catchUpSession(adapter.agentKind, 'session')
    expect(rows().map(e => e.data.transcript_uuid)).toEqual(['completed'])
    fs.writeFileSync(file, line('later-unit')); catchUpSession(adapter.agentKind, 'session')
    expect(rows().map(e => e.data.transcript_uuid).sort()).toEqual(['completed', 'later-unit'])
  })

})

describe('a failed write without a restart', () => {
  const child = (uuid: string, parentUuid: string | null) => JSON.stringify({ uuid, parentUuid, type: 'user', textContent: uuid }) + '\n'
  const ids = () => rows().map(e => String(e.data.transcript_uuid)).sort()
  const failOn = (uuid: string) => {
    const real = ingestion.ingestEvent
    return vi.spyOn(ingestion, 'ingestEvent').mockImplementation((kind, data, options) => {
      if (data.transcript_uuid === uuid) throw new Error('injected DB write refusal')
      return real(kind, data, options)
    })
  }
  const session = () => [..._sessionsForTest().values()][0]

  it('keeps a waiting child whose flush failed, for the next pass and for a restart', () => {
    fs.writeFileSync(source, child('c', 'p')); start()
    fs.appendFileSync(source, child('p', null))
    const fail = failOn('c'); catchUp(); fail.mockRestore()
    expect(ids()).toEqual(['p'])
    restart(); catchUp()
    expect(ids()).toEqual(['c', 'p'])
  })

  it('queues a waiting child once, however often a failed pass is read again', () => {
    fs.writeFileSync(source, child('c', 'never') + child('x', null))
    const fail = failOn('x'); start(); catchUp(); catchUp(); fail.mockRestore()
    expect(session().pendingByParentUuid.get('never')).toHaveLength(1)
  })

  it('counts a tool call once when its unit is read again', () => {
    registerAdapter({ ...adapter, knownIngestTypes: new Set(['tool_use']), subtypeFor: () => 'tool_call' })
    configureHost(cfg)
    fs.writeFileSync(source, JSON.stringify({ uuid: 't1', type: 'tool_use', toolName: 'Bash', toolInput: { command: 'id' } }) + '\n')
    const fail = failOn('t1'); registerSession(adapter.agentKind, source); fail.mockRestore(); catchUp()
    expect([session().toolCallsSeen, session().toolCallsEmitted]).toEqual([1, 1])
  })

  it('retries the last unit of a session by itself, with no further file event', async () => {
    vi.useFakeTimers()
    try {
      fs.writeFileSync(source, line('last-words'))
      const fail = failOn('last-words'); start(); fail.mockRestore()
      expect(ids()).toEqual([])
      await vi.advanceTimersByTimeAsync(1000)
      expect(ids()).toEqual(['last-words'])
    } finally { vi.useRealTimers() }
  })

  it('retries a per-message unit on the next pass, without the file changing', () => {
    source = path.join(dir, 'session'); fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, 'a.json'), line('a')); fs.writeFileSync(path.join(source, 'b.json'), line('b'))
    const fail = failOn('b'); start(true); fail.mockRestore()
    expect(ids()).toEqual(['a'])
    catchUpSession(adapter.agentKind, 'session')
    expect(ids()).toEqual(['a', 'b'])
  })
})

describe('a sidecar removed by retention', () => {
  it('resumes from the checkpoint, neither stopping nor replaying', () => {
    fs.writeFileSync(source, line('old')); start()
    const sidecar = [..._sessionsForTest().values()][0].sidecarPath
    stopHost(); fs.rmSync(sidecar)
    fs.appendFileSync(source, line('new')); start(); catchUp()
    expect(rows().map(e => e.data.transcript_uuid).sort()).toEqual(['new', 'old'])
    expect(fs.readFileSync(sidecar, 'utf8')).toBe(line('new'))
  })

  it('still refuses a sidecar that is present but shorter than its checkpoint', () => {
    fs.writeFileSync(source, line('old')); start()
    const sidecar = [..._sessionsForTest().values()][0].sidecarPath
    stopHost(); fs.writeFileSync(sidecar, '')
    fs.appendFileSync(source, line('new')); start(); catchUp()
    expect(rows().map(e => e.data.transcript_uuid)).toEqual(['old'])
  })
})
