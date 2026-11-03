import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../src/core/fs-acl', () => ({ restrictToOwner: vi.fn() }))

import { restrictToOwner } from '../src/core/fs-acl'
import { claudeCodeAdapter } from '../optional-plugins/claude-code/adapter'
import { registerAdapter, configureHost, registerSession, stopHost, _sessionsForTest } from '../src/main/services/tailer-host'
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
const acl = vi.mocked(restrictToOwner)

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
})

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform)
  stopHost()
  clearCaptureError('agent-claude-code')
  try { closeDB() } catch { /* ignore */ }
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('the AI sidecar directory on Windows', () => {
  it('is restricted to its owner when the first session is registered', () => {
    setPlatform('win32')
    registerSession('claude-code', source(SID_A))

    expect(acl.mock.calls.map(([target]) => target)).toEqual([sidecarDir])
    expect(_sessionsForTest().has(`claude-code:${SID_A}`)).toBe(true)
  })

  it('is restricted once, not once per session', () => {
    setPlatform('win32')
    registerSession('claude-code', source(SID_A))
    registerSession('claude-code', source(SID_B))

    expect(acl.mock.calls).toHaveLength(1)
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
      sidecarDir
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
    expect(acl).toHaveBeenCalledTimes(2)
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
