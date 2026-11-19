import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { _replaceIcaclsForTests } from '../src/core/fs-acl'
import { claudeCodeAdapter } from '../optional-plugins/claude-code/adapter'
import { registerAdapter, configureHost, registerSession, catchUpSession, stopHost, _sessionsForTest } from '../src/main/services/tailer-host'
import { getCaptureError, clearCaptureError } from '../src/core/capture-health'
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
  configureHost({ enabled: true, identity: { projectId: 'p1', engagementId: 'e1', operatorId: OP }, idleFlushMs: 60_000, previewChars: 1000 })
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
  vi.useRealTimers()
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
    expect(getCaptureError('agent-claude-code')).toMatchObject({ message: expect.stringContaining(SID_A) })
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
    expect(getCaptureError('agent-claude-code')).toMatchObject({ message: expect.stringContaining(SID_A) })

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
    expect(getCaptureError('agent-claude-code')).toMatchObject({ message: expect.stringContaining(SID_A) })

    const sidecarB = failSidecar(SID_B)
    vi.advanceTimersByTime(1000)
    expect(getCaptureError('agent-claude-code')).toMatchObject({ message: expect.stringContaining(SID_B) })
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

  it('creates owner-only POSIX files', { skip: process.platform === 'win32' }, () => {
    registerSession('claude-code', source(SID_A))
    const sidecar = _sessionsForTest().get(`claude-code:${SID_A}`)!.sidecarPath
    expect(fs.statSync(sidecar).mode & 0o777).toBe(0o600)
    expect(acl).not.toHaveBeenCalled()
  })
})
