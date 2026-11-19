import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
vi.mock('fs', async original => ({ ...await original<typeof import('fs')>() }))
import * as os from 'os'
import * as path from 'path'

import { _replaceIcaclsForTests } from '../src/core/fs-acl'
import { claudeCodeAdapter } from '../optional-plugins/claude-code/adapter'
import { registerAdapter, unregisterAdapter, configureHost, registerSession, catchUpSession, stopHost, _sessionsForTest } from '../src/main/services/tailer-host'
import { getCaptureError, clearCaptureError, noteCaptureError } from '../src/core/capture-health'
import { eventBus } from '../src/core/event-bus'
import { queryEvents } from '../src/core/db/events'
import { initDB, closeDB } from '../src/core/db/index'
import { createOperator, generateToken } from '../src/core/db/operators'

// The sidecar holds a conversation byte for byte: thinking, credentials the
// event path would have masked. 0o700/0o600 do nothing on NTFS, so on Windows
// the directory takes the same icacls restriction as the keys directory, and
// a directory it cannot restrict receives no raw content.

const OP = 'operator-1'
const SID_A = 'aaaaaaaa-bbbb-cccc-dddd-0000000000a1'
const SID_B = 'aaaaaaaa-bbbb-cccc-dddd-0000000000b2'
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const setPlatform = (value: string): void => { Object.defineProperty(process, 'platform', { value }) }
const acl = vi.fn<(target: string) => void>()
const realUser = process.env.USERNAME

let scratch: string
let sidecarDir: string
let projectDir: string

const turn = (uuid: string, text: string): string => JSON.stringify({
  type: 'user', uuid, cwd: '/tmp/acl',
  message: { role: 'user', content: [{ type: 'text', text }] }
}) + '\n'

function source(sid: string): string {
  const file = path.join(scratch, 'claude-projects', '-tmp-acl', `${sid}.jsonl`)
  fs.writeFileSync(file, turn('u1', 'SECRET-CONVERSATION'))
  return file
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tailer-acl-'))
  projectDir = scratch
  sidecarDir = path.join(projectDir, 'agent-transcripts')
  initDB(scratch)
  createOperator({ id: OP, name: 'Operator 1', token: generateToken() })
  fs.mkdirSync(path.join(scratch, 'claude-projects', '-tmp-acl'), { recursive: true })
  claudeCodeAdapter.transcriptGlob = path.join(scratch, 'claude-projects', '**', '*.jsonl')
  registerAdapter(claudeCodeAdapter)
  configureHost({ activationStarts: undefined, excludedSessionsByAgent: undefined, enabledAgents: undefined, enabled: true, identity: { projectId: 'p1', engagementId: 'e1', operatorId: OP }, idleFlushMs: 60_000, previewChars: 1000 })
  acl.mockReset()
  process.env.USERNAME = 'tester'
  _replaceIcaclsForTests((args) => acl(args[0]))
})

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform)
  _replaceIcaclsForTests(null)
  if (realUser === undefined) delete process.env.USERNAME
  else process.env.USERNAME = realUser
  stopHost()
  if (eventBus.paused) eventBus.resume()
  vi.restoreAllMocks()
  vi.useRealTimers()
  clearCaptureError('agent-claude-code')
  for (const sid of [SID_A, SID_B]) clearCaptureError('agent-claude-code', path.join(sidecarDir, `claude-code-${sid}.jsonl`))
  try { closeDB() } catch { /* ignore */ }
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('the AI sidecar directory on Windows', () => {
  it('is restricted to its owner when the first session is registered', () => {
    setPlatform('win32')
    registerSession('claude-code', source(SID_A))

    expect(acl.mock.calls.map(([target]) => target)).toEqual([sidecarDir, path.join(sidecarDir, `claude-code-${SID_A}.jsonl`)])
    expect(_sessionsForTest().has(`claude-code:${SID_A}`)).toBe(true)
  })

  it('is restricted once, not once per session', () => {
    setPlatform('win32')
    registerSession('claude-code', source(SID_A))
    registerSession('claude-code', source(SID_B))

    expect(acl.mock.calls.filter(([target]) => target === sidecarDir)).toHaveLength(1)
  })

  it('restricts the files already there before the directory, so none is left with nothing explicit', () => {
    setPlatform('win32')
    fs.mkdirSync(sidecarDir, { recursive: true })
    fs.writeFileSync(path.join(sidecarDir, 'claude-code-old.jsonl'), 'earlier')
    fs.writeFileSync(path.join(sidecarDir, 'claude-code-old.jsonl.offset.json'), '{}')
    registerSession('claude-code', source(SID_A))

    expect(acl.mock.calls.map(([target]) => target)).toEqual([
      path.join(sidecarDir, 'claude-code-old.jsonl'),
      path.join(sidecarDir, 'claude-code-old.jsonl.offset.json'),
      sidecarDir,
      path.join(sidecarDir, `claude-code-${SID_A}.jsonl`)
    ])
  })

  it('saves no raw content, and reports a capture error, when it cannot be restricted', () => {
    setPlatform('win32')
    acl.mockImplementation(() => { throw new Error('icacls: access denied') })
    registerSession('claude-code', source(SID_A))

    expect(_sessionsForTest().has(`claude-code:${SID_A}`)).toBe(false)
    expect(getCaptureError('agent-claude-code')?.message).toContain('icacls: access denied')
    const saved = fs.existsSync(sidecarDir) ? fs.readdirSync(sidecarDir).filter((n) => n.endsWith('.jsonl')) : []
    expect(saved).toEqual([])
  })

  it('is tried again after a failure, until it succeeds', () => {
    setPlatform('win32')
    acl.mockImplementationOnce(() => { throw new Error('icacls: access denied') })
    registerSession('claude-code', source(SID_A))
    registerSession('claude-code', source(SID_A))

    expect(_sessionsForTest().has(`claude-code:${SID_A}`)).toBe(true)
    expect(acl).toHaveBeenCalledTimes(3)
  })
})

describe('the AI sidecar directory on POSIX', () => {
  // Not stubbed to 'linux' on a Windows host: registration itself depends on
  // the real platform's path rules, so only a real POSIX run proves this.
  it('keeps the 0o700 mode, calls no ACL helper and writes no marker', { skip: process.platform === 'win32' }, () => {
    registerSession('claude-code', source(SID_A))

    expect(_sessionsForTest().has(`claude-code:${SID_A}`)).toBe(true)
    expect(acl).not.toHaveBeenCalled()
    expect(fs.statSync(sidecarDir).mode & 0o777).toBe(0o700)
    expect(fs.existsSync(path.join(sidecarDir, '.owner-only'))).toBe(false)
  })
})

describe('new AI sidecar files', () => {
  it('restricts each empty file once before content, including a recreated file', () => {
    setPlatform('win32')
    const file = source(SID_A)
    const contentAtRestriction: string[] = []
    acl.mockImplementation((target) => {
      if (target.endsWith('.jsonl')) contentAtRestriction.push(fs.readFileSync(target, 'utf8'))
    })
    registerSession('claude-code', file)
    const sidecar = _sessionsForTest().get(`claude-code:${SID_A}`)!.sidecarPath
    expect(acl.mock.calls.shift()).toEqual([sidecarDir])
    expect(contentAtRestriction, 'sidecar must be empty when restricted').toEqual([''])
    expect(acl.mock.calls.map(([target]) => target)).toEqual([sidecar])
    fs.appendFileSync(file, turn('u2', 'first'))
    catchUpSession('claude-code', SID_A)
    expect(acl.mock.calls.map(([target]) => target)).toEqual([sidecar])
    expect(fs.readFileSync(sidecar, 'utf8')).toContain('first')
    fs.appendFileSync(file, turn('u3', 'second'))
    catchUpSession('claude-code', SID_A)
    expect(acl).toHaveBeenCalledTimes(1)
    expect(fs.readFileSync(sidecar, 'utf8')).toContain('second')

    registerSession('claude-code', source(SID_B))
    const other = _sessionsForTest().get(`claude-code:${SID_B}`)!.sidecarPath
    expect(acl.mock.calls.map(([target]) => target)).toEqual([sidecar, other])
    expect(contentAtRestriction, 'each new sidecar must be empty when restricted').toEqual(['', ''])
    fs.renameSync(sidecar, sidecar + '.rotated')
    fs.appendFileSync(file, turn('u4', 'third'))
    catchUpSession('claude-code', SID_A)
    expect(acl.mock.calls.map(([target]) => target)).toEqual([sidecar, other, sidecar])
    expect(contentAtRestriction, 'recreated sidecar must be empty when restricted').toEqual(['', '', ''])
    expect(fs.readFileSync(sidecar, 'utf8')).toContain('third')
  })

  function failSidecar(sid: string): string {
    const sidecar = path.join(sidecarDir, `claude-code-${sid}.jsonl`)
    acl.mockImplementation((target) => {
      if (target === sidecar) throw new Error('icacls: access denied')
    })
    return sidecar
  }

  it('records the redacted event and reports which session has an empty raw sidecar', () => {
    setPlatform('win32')
    const file = source(SID_A)
    fs.writeFileSync(file, turn('u1', 'export API_KEY=abcdef1234567890'))
    const sidecar = failSidecar(SID_A)
    registerSession('claude-code', file)

    const event = queryEvents({ agentType: 'agent', limit: 20 })
      .find(({ data }) => data.session_id === SID_A && data.subtype === 'user_message')
    expect(event?.data.full).toEqual(expect.stringContaining('[REDACTED]'))
    expect(JSON.stringify(event)).not.toContain('abcdef1234567890')
    expect(fs.readFileSync(sidecar, 'utf8')).toBe('')
    expect(_sessionsForTest().get(`claude-code:${SID_A}`)?.sourceOffset).toBe(0)
    expect(getCaptureError('agent-claude-code')).toMatchObject({ sidecarSessionId: SID_A })
  })

  it('keeps the failed session visible after another session of the same kind succeeds', () => {
    setPlatform('win32')
    vi.useFakeTimers()
    const sidecar = failSidecar(SID_A)
    registerSession('claude-code', source(SID_A))
    expect(getCaptureError('agent-claude-code')).toBeDefined()

    vi.advanceTimersByTime(100)
    registerSession('claude-code', source(SID_B))
    const other = _sessionsForTest().get(`claude-code:${SID_B}`)!.sidecarPath
    expect(fs.readFileSync(other, 'utf8')).toContain('SECRET-CONVERSATION')
    expect(fs.readFileSync(sidecar, 'utf8')).toBe('')
    expect(getCaptureError('agent-claude-code')).toMatchObject({ sidecarSessionId: SID_A })

    acl.mockImplementation(() => {})
    vi.advanceTimersByTime(900)
    expect(fs.readFileSync(sidecar, 'utf8')).toContain('SECRET-CONVERSATION')
    expect(getCaptureError('agent-claude-code')).toBeUndefined()
  })

  it('keeps each failed session until its own sidecar is written', () => {
    setPlatform('win32')
    vi.useFakeTimers()
    const fileA = source(SID_A)
    const fileB = source(SID_B)
    acl.mockImplementation((target) => {
      if (target.endsWith('.jsonl')) throw new Error('icacls: access denied')
    })
    registerSession('claude-code', fileA)
    registerSession('claude-code', fileB)
    expect(getCaptureError('agent-claude-code')).toMatchObject({ sidecarSessionId: SID_A })

    const sidecarB = failSidecar(SID_B)
    vi.advanceTimersByTime(1000)
    expect(getCaptureError('agent-claude-code')).toMatchObject({ sidecarSessionId: SID_B })
    expect(fs.readFileSync(sidecarB, 'utf8')).toBe('')

    acl.mockReset()
    vi.advanceTimersByTime(2000)
    expect(fs.readFileSync(sidecarB, 'utf8')).toContain('SECRET-CONVERSATION')
    expect(getCaptureError('agent-claude-code')).toBeUndefined()
  })

  it('keeps the error visible after the retry budget and the capture error TTL pass', () => {
    setPlatform('win32')
    vi.useFakeTimers()
    const sidecar = failSidecar(SID_A)
    registerSession('claude-code', source(SID_A))

    vi.advanceTimersByTime(31_000)
    expect(acl.mock.calls.filter(([target]) => target === sidecar)).toHaveLength(6)
    vi.advanceTimersByTime(11 * 60_000)
    expect(acl.mock.calls.filter(([target]) => target === sidecar)).toHaveLength(6)
    expect(fs.readFileSync(sidecar, 'utf8')).toBe('')
    expect(getCaptureError('agent-claude-code')).toBeDefined()
  })

  it('bounds sidecar ACL attempts during file changes and after automatic retries stop', () => {
    setPlatform('win32')
    vi.useFakeTimers()
    const file = source(SID_A)
    const sidecar = failSidecar(SID_A)
    registerSession('claude-code', file)
    const attempts = () => acl.mock.calls.filter(([target]) => target === sidecar).length
    const changes = () => {
      for (let i = 0; i < 6; i++) {
        fs.appendFileSync(file, turn(`u${fs.statSync(file).size}`, 'more'))
        catchUpSession('claude-code', SID_A)
      }
    }

    for (const [index, delay] of [1000, 2000, 4000, 8000, 16_000].entries()) {
      vi.advanceTimersByTime(delay - 1)
      changes()
      expect(attempts(), 'file changes cannot accelerate the retry').toBe(index + 1)
      vi.advanceTimersByTime(1)
      expect(attempts()).toBe(index + 2)
    }
    vi.advanceTimersByTime(15_999)
    changes()
    expect(attempts()).toBe(6)
    vi.advanceTimersByTime(1)
    changes()
    expect(attempts()).toBe(7)
    expect(fs.readFileSync(sidecar, 'utf8')).toBe('')
  })

  const uuids = () => queryEvents({ agentType: 'agent', limit: 500 })
    .filter(({ data }) => data.subtype === 'user_message' || data.subtype === 'assistant_message')
    .map(({ data }) => data.transcript_uuid).sort()
  const gaps = () => queryEvents({ limit: 500 }).filter(({ data }) => data.subtype === 'capture_gap').map(({ data }) => data)

  it('records the last reply immediately during cooldown and retries its raw bytes at the trailing edge', () => {
    setPlatform('win32')
    vi.useFakeTimers()
    const file = source(SID_A)
    const sidecar = failSidecar(SID_A)
    registerSession('claude-code', file)
    vi.advanceTimersByTime(91_000)
    fs.appendFileSync(file, turn('prompt', 'operator prompt'))
    catchUpSession('claude-code', SID_A)
    vi.advanceTimersByTime(5000)
    fs.appendFileSync(file, turn('final', 'final reply').replace('"type":"user"', '"type":"assistant"').replace('"role":"user"', '"role":"assistant"'))
    catchUpSession('claude-code', SID_A)
    expect.soft(uuids()).toEqual(['final', 'prompt', 'u1'])
    expect(fs.readFileSync(sidecar, 'utf8')).toBe('')
    acl.mockReset()
    vi.advanceTimersByTime(10_999)
    expect(fs.readFileSync(sidecar, 'utf8')).toBe('')
    vi.advanceTimersByTime(1)
    expect.soft(fs.readFileSync(sidecar, 'utf8')).toBe(fs.readFileSync(file, 'utf8'))
    expect(uuids()).toEqual(['final', 'prompt', 'u1'])
  })

  it('seeds already emitted UUIDs when an adapter re-registers a failing session', () => {
    setPlatform('win32')
    vi.useFakeTimers()
    const file = source(SID_A)
    failSidecar(SID_A)
    registerSession('claude-code', file)
    unregisterAdapter('claude-code')
    registerAdapter(claudeCodeAdapter)
    registerSession('claude-code', file)
    expect(uuids()).toEqual(['u1'])
  })

  it.each(['excluded', 'superseded', 'disabled', 'unregistered'] as const)(
    'retires the pending raw copy and records its gap when %s',
    (reason) => {
      setPlatform('win32')
      vi.useFakeTimers()
      const file = source(SID_A)
      const sidecar = failSidecar(SID_A)
      registerSession('claude-code', file)
      const skipped = fs.statSync(file).size
      expect(getCaptureError('agent-claude-code')).toBeDefined()
      if (reason === 'excluded') configureHost({ excludedSessionsByAgent: { 'claude-code': [SID_A] } })
      if (reason === 'disabled') configureHost({ enabledAgents: [] })
      if (reason === 'unregistered') {
        unregisterAdapter('claude-code')
        registerAdapter(claudeCodeAdapter)
      }
      if (reason === 'superseded') {
        acl.mockReset()
        configureHost({ activationStarts: { 'claude-code': Math.ceil(fs.statSync(file).birthtimeMs) + 1 } })
        registerSession('claude-code', file)
        const fresh = _sessionsForTest().get(`claude-code:${SID_A}`)!.sidecarPath
        fs.appendFileSync(file, turn('u2', 'new activation'))
        catchUpSession('claude-code', SID_A)
        expect(fs.readFileSync(fresh, 'utf8')).toBe(turn('u2', 'new activation'))
      }
      vi.advanceTimersByTime(60 * 60_000)
      expect.soft(getCaptureError('agent-claude-code')).toBeUndefined()
      expect.soft(gaps()).toEqual([expect.objectContaining({ session_id: SID_A, skipped_bytes: skipped, missing: 'raw' })])
      expect(fs.readFileSync(sidecar, 'utf8')).toBe('')
    }
  )

  it('accounts separately for raw bytes already processed and content skipped during pause', () => {
    setPlatform('win32')
    vi.useFakeTimers()
    const file = source(SID_A)
    const sidecar = failSidecar(SID_A)
    registerSession('claude-code', file)
    const firstBytes = fs.statSync(file).size
    const paused = turn('paused', 'private while paused')
    eventBus.pause()
    fs.appendFileSync(file, paused)
    eventBus.resume()
    acl.mockReset()
    fs.appendFileSync(file, turn('u2', 'after resume'))
    catchUpSession('claude-code', SID_A)
    expect.soft(fs.readFileSync(sidecar, 'utf8')).toBe('')
    vi.advanceTimersByTime(1000)
    expect.soft(uuids()).toEqual(['u1', 'u2'])
    expect.soft(fs.readFileSync(sidecar, 'utf8')).toBe(turn('u2', 'after resume'))
    expect.soft(gaps()).toEqual(expect.arrayContaining([
      expect.objectContaining({ missing: 'raw', skipped_bytes: firstBytes }),
      expect.objectContaining({ skipped_bytes: Buffer.byteLength(paused), description: expect.stringContaining('events and sidecar') })
    ]))
    expect(gaps()).toHaveLength(2)
    expect(getCaptureError('agent-claude-code')).toBeUndefined()
  })

  it('reports a sidecar create failure even after another session writes and the transient TTL elapses', () => {
    setPlatform('win32')
    vi.useFakeTimers()
    const file = source(SID_A)
    const sidecar = path.join(sidecarDir, `claude-code-${SID_A}.jsonl`)
    const open = fs.openSync
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      if (file === sidecar) throw new Error('EACCES creating sidecar')
      return open(file, flags, mode)
    })
    registerSession('claude-code', file)
    const other = source(SID_B)
    fs.writeFileSync(other, turn('other', 'another session'))
    registerSession('claude-code', other)
    vi.advanceTimersByTime(11 * 60_000)
    expect(getCaptureError('agent-claude-code')).toMatchObject({ sidecarSessionId: SID_A, message: expect.stringContaining('EACCES creating sidecar') })
    expect(uuids()).toEqual(['other', 'u1'])
  })

  it('prefers a live source-wide failure and falls back to the pending raw copy', () => {
    setPlatform('win32')
    vi.useFakeTimers()
    failSidecar(SID_A)
    registerSession('claude-code', source(SID_A))
    noteCaptureError('agent-claude-code', new Error('EACCES: recording boundary unavailable'))
    expect.soft(getCaptureError('agent-claude-code')?.message).toContain('EACCES')
    vi.advanceTimersByTime(11 * 60_000)
    expect(getCaptureError('agent-claude-code')?.sidecarSessionId).toBe(SID_A)
  })

  it('reports the actual failure with complete fallback text for a 64-character session ID', () => {
    setPlatform('win32')
    const sid = 'a'.repeat(64)
    const sidecar = path.join(sidecarDir, `claude-code-${sid}.jsonl`)
    acl.mockImplementation((target) => {
      if (target === sidecar) throw new Error('icacls timed out')
    })
    registerSession('claude-code', source(sid))
    const error = getCaptureError('agent-claude-code')
    expect(error).toMatchObject({
      sidecarSessionId: sid,
      message: 'Raw conversation is not being saved. RedLog retries when the transcript changes. Cause: icacls timed out'
    })
  })

  it('replaces an earlier generic retry when a sidecar failure starts its backoff', () => {
    setPlatform('win32')
    vi.useFakeTimers()
    const file = source(SID_A)
    const sidecar = failSidecar(SID_A)
    const parse = vi.spyOn(claudeCodeAdapter, 'parseUnit').mockImplementationOnce(() => { throw new Error('transient parse error') })
    registerSession('claude-code', file)
    vi.advanceTimersByTime(900)
    catchUpSession('claude-code', SID_A)
    const attempts = () => acl.mock.calls.filter(([target]) => target === sidecar).length
    expect(attempts()).toBe(1)
    vi.advanceTimersByTime(100)
    expect(attempts()).toBe(1)
    vi.advanceTimersByTime(900)
    expect(attempts()).toBe(2)
    parse.mockRestore()
  })

  it('continues recording per-message events while the sidecar index is waiting to retry', () => {
    setPlatform('win32')
    vi.useFakeTimers()
    const dir = path.join(scratch, SID_A)
    fs.mkdirSync(dir)
    const adapter = {
      ...claudeCodeAdapter, perMessageDir: true,
      transcriptRoot: path.join(scratch, 'unused'), resolveCwd: () => scratch
    }
    registerAdapter(adapter)
    const sidecar = failSidecar(SID_A)
    fs.writeFileSync(path.join(dir, 'one.json'), turn('u1', 'first'))
    registerSession('claude-code', dir)
    fs.writeFileSync(path.join(dir, 'two.json'), turn('u2', 'second'))
    catchUpSession('claude-code', SID_A)
    expect.soft(uuids()).toEqual(['u1', 'u2'])
    expect(acl.mock.calls.filter(([target]) => target === sidecar)).toHaveLength(1)
    expect(fs.readFileSync(sidecar, 'utf8')).toBe('')
    acl.mockReset()
    vi.advanceTimersByTime(1000)
    expect(uuids()).toEqual(['u1', 'u2'])
    expect(fs.readFileSync(sidecar, 'utf8')).toBe('one.json\ntwo.json\n')
    expect(getCaptureError('agent-claude-code')).toBeUndefined()
  })

  it('retires an unresolved sidecar even when the next settings change arrives before rediscovery', () => {
    setPlatform('win32')
    vi.useFakeTimers()
    const file = source(SID_A)
    failSidecar(SID_A)
    registerSession('claude-code', file)
    configureHost({})
    expect(getCaptureError('agent-claude-code')?.sidecarSessionId).toBe(SID_A)
    configureHost({ enabledAgents: [] })
    expect.soft(getCaptureError('agent-claude-code')).toBeUndefined()
    expect(gaps()).toEqual([expect.objectContaining({ missing: 'raw', skipped_bytes: Buffer.byteLength(turn('u1', 'SECRET-CONVERSATION')) })])
  })

  it('keeps a stopped tailer visible above a pending sidecar until its recording boundary is usable', () => {
    setPlatform('win32')
    vi.useFakeTimers()
    const file = source(SID_A)
    failSidecar(SID_A)
    registerSession('claude-code', file)
    const rename = fs.renameSync
    const refused = vi.spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
      if (String(newPath).endsWith('.recording-boundary.json')) throw new Error('EACCES recording boundary')
      return rename(oldPath, newPath)
    })
    eventBus.pause()
    vi.advanceTimersByTime(11 * 60_000)
    expect(getCaptureError('agent-claude-code')?.message).toContain('EACCES recording boundary')
    eventBus.resume()
    refused.mockRestore()
    acl.mockReset()
    configureHost({ enabled: true })
    registerSession('claude-code', file)
    expect(getCaptureError('agent-claude-code')).toBeUndefined()
  })

  it('creates owner-only POSIX files', { skip: process.platform === 'win32' }, () => {
    registerSession('claude-code', source(SID_A))
    const sidecar = _sessionsForTest().get(`claude-code:${SID_A}`)!.sidecarPath
    expect(fs.statSync(sidecar).mode & 0o777).toBe(0o600)
    expect(acl).not.toHaveBeenCalled()
  })
})
