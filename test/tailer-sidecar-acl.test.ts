import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { clearIcacls, failNextIcacls, icaclsCalls } from './helpers/icacls'
import { claudeCodeAdapter } from '../optional-plugins/claude-code/adapter'
import { registerAdapter, configureHost, registerSession, catchUpSession, stopHost, _sessionsForTest } from '../src/main/services/tailer-host'
import { getCaptureError, clearCaptureError } from '../src/core/capture-health'
import { initDB, closeDB } from '../src/core/db/index'
import { createOperator, generateToken } from '../src/core/db/operators'

// The sidecar holds a conversation byte for byte: thinking, credentials the
// event path would have masked. 0o700/0o600 do nothing on NTFS, so on Windows
// the directory gives its owner an inheritable grant. A directory it cannot
// restrict receives no raw content.

const OP = 'operator-1'
const SID_A = 'aaaaaaaa-bbbb-cccc-dddd-0000000000a1'
const SID_B = 'aaaaaaaa-bbbb-cccc-dddd-0000000000b2'
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const setPlatform = (value: string): void => { Object.defineProperty(process, 'platform', { value }) }
const realUser = process.env.USERNAME
const ownerGrant = (target: string): string[] => [target, '/inheritance:r', '/grant:r', 'tester:(F)']
const directoryGrant = (target: string): string[] => [target, '/inheritance:r', '/grant:r', 'tester:(OI)(CI)(F)']

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
  process.env.USERNAME = 'tester'
  clearIcacls()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform)
  if (realUser === undefined) delete process.env.USERNAME
  else process.env.USERNAME = realUser
  stopHost()
  clearCaptureError('agent-claude-code')
  try { closeDB() } catch { /* ignore */ }
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('the AI sidecar directory on Windows', () => {
  it('restricts existing files first, then grants inheritable full control on the directory', () => {
    setPlatform('win32')
    fs.mkdirSync(sidecarDir)
    const earlier = path.join(sidecarDir, 'claude-code-old.jsonl')
    fs.writeFileSync(earlier, 'earlier')
    registerSession('claude-code', source(SID_A))

    expect(icaclsCalls()).toEqual([ownerGrant(earlier), directoryGrant(sidecarDir)])
  })

  it('writes new sidecars without another icacls call', () => {
    setPlatform('win32')
    registerSession('claude-code', source(SID_A))
    clearIcacls()

    registerSession('claude-code', source(SID_B))
    catchUpSession('claude-code', SID_B)
    const sidecar = _sessionsForTest().get(`claude-code:${SID_B}`)!.sidecarPath
    expect(fs.readFileSync(sidecar, 'utf8')).toContain('SECRET-CONVERSATION')
    expect(icaclsCalls()).toEqual([])
  })

  it('re-applies an old-style marker once and reuses the updated marker on reopen', () => {
    setPlatform('win32')
    fs.mkdirSync(sidecarDir)
    const marker = path.join(sidecarDir, '.owner-only')
    fs.writeFileSync(marker, '')
    const file = source(SID_A)

    registerSession('claude-code', file)
    expect(icaclsCalls()).toEqual([ownerGrant(marker), directoryGrant(sidecarDir)])

    stopHost()
    clearIcacls()
    registerSession('claude-code', file)
    expect(_sessionsForTest().has(`claude-code:${SID_A}`)).toBe(true)
    expect(icaclsCalls()).toEqual([])
  })

  it('re-applies the grant when the marker was copied from another directory', () => {
    setPlatform('win32')
    registerSession('claude-code', source(SID_A))
    const marker = path.join(sidecarDir, '.owner-only')
    const original = path.join(projectDir, 'original-transcripts')
    fs.renameSync(sidecarDir, original)
    fs.mkdirSync(sidecarDir)
    fs.copyFileSync(path.join(original, '.owner-only'), marker)
    clearIcacls()

    registerSession('claude-code', source(SID_B))
    expect(icaclsCalls()).toEqual([ownerGrant(marker), directoryGrant(sidecarDir)])
  })

  it('saves no raw content, and reports a capture error, when it cannot be restricted', () => {
    setPlatform('win32')
    failNextIcacls(new Error('icacls: access denied'))
    registerSession('claude-code', source(SID_A))

    expect(_sessionsForTest().has(`claude-code:${SID_A}`)).toBe(false)
    expect(getCaptureError('agent-claude-code')?.message).toContain('icacls: access denied')
    const saved = fs.existsSync(sidecarDir) ? fs.readdirSync(sidecarDir).filter((n) => n.endsWith('.jsonl')) : []
    expect(saved).toEqual([])
  })

  it('is tried again after a failure, until it succeeds', () => {
    setPlatform('win32')
    failNextIcacls(new Error('icacls: access denied'))
    registerSession('claude-code', source(SID_A))
    registerSession('claude-code', source(SID_A))

    expect(_sessionsForTest().has(`claude-code:${SID_A}`)).toBe(true)
    expect(icaclsCalls()).toHaveLength(2)
  })
})

describe('the AI sidecar directory on POSIX', () => {
  // Not stubbed to 'linux' on a Windows host: registration itself depends on
  // the real platform's path rules, so only a real POSIX run proves this.
  it('keeps the 0o700 directory and 0o600 file modes, calls no icacls and writes no marker', { skip: process.platform === 'win32' }, () => {
    registerSession('claude-code', source(SID_A))

    catchUpSession('claude-code', SID_A)
    const sidecar = _sessionsForTest().get(`claude-code:${SID_A}`)!.sidecarPath
    expect(icaclsCalls()).toEqual([])
    expect(fs.statSync(sidecarDir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(sidecar).mode & 0o777).toBe(0o600)
    expect(fs.statSync(sidecar + '.offset.json').mode & 0o777).toBe(0o600)
    expect(fs.existsSync(path.join(sidecarDir, '.owner-only'))).toBe(false)
  })
})
