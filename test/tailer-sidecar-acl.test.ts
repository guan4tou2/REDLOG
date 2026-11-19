import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { _replaceIcaclsForTests } from '../src/core/fs-acl'
import { claudeCodeAdapter } from '../optional-plugins/claude-code/adapter'
import { registerAdapter, configureHost, registerSession, catchUpSession, stopHost, _sessionsForTest } from '../src/main/services/tailer-host'
import { getCaptureError, clearCaptureError } from '../src/core/capture-health'
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
  clearCaptureError('agent-claude-code')
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

  it('leaves no conversation or advanced cursor on restriction failure and retries', () => {
    setPlatform('win32')
    const file = source(SID_A)
    acl.mockImplementation((target) => {
      if (target.endsWith('.jsonl')) throw new Error('icacls: access denied')
    })
    registerSession('claude-code', file)
    const session = _sessionsForTest().get(`claude-code:${SID_A}`)!
    expect(acl.mock.calls.shift()).toEqual([sidecarDir])
    expect(fs.readFileSync(session.sidecarPath, 'utf8')).toBe('')
    expect(session.sourceOffset).toBe(0)
    expect(getCaptureError('agent-claude-code')?.message).toContain('icacls: access denied')
    acl.mockImplementation(() => {})
    catchUpSession('claude-code', SID_A)
    expect(acl).toHaveBeenCalledTimes(2)
    expect(fs.readFileSync(session.sidecarPath, 'utf8')).toContain('SECRET-CONVERSATION')
    expect(getCaptureError('agent-claude-code')).toBeUndefined()
  })

  it('creates owner-only POSIX files', { skip: process.platform === 'win32' }, () => {
    registerSession('claude-code', source(SID_A))
    const sidecar = _sessionsForTest().get(`claude-code:${SID_A}`)!.sidecarPath
    expect(fs.statSync(sidecar).mode & 0o777).toBe(0o600)
    expect(acl).not.toHaveBeenCalled()
  })
})
