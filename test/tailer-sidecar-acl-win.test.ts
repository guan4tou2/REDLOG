import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'node:child_process'
import { claudeCodeAdapter } from '../optional-plugins/claude-code/adapter'
import { registerAdapter, configureHost, registerSession, catchUpSession, stopHost, _sessionsForTest } from '../src/main/services/tailer-host'
import { initDB, closeDB } from '../src/core/db/index'
import { createOperator, generateToken } from '../src/core/db/operators'
import { aclEntries, aclListing, isCurrentUser, useRealIcacls } from './helpers/icacls'

const IS_WIN = process.platform === 'win32'
const OP = 'operator-1'
const SID = 'aaaaaaaa-bbbb-cccc-dddd-0000000000w1'

let scratch: string

const turn = (uuid: string, text: string): string => JSON.stringify({
  type: 'user', uuid, cwd: '/tmp/acl',
  message: { role: 'user', content: [{ type: 'text', text }] }
}) + '\n'

function expectRestrictedListing(target: string, out: string): void {
  const entries = aclEntries(target, out)
  expect(entries.some(entry => /:\(F\)$/.test(entry) && isCurrentUser(entry)), out).toBe(true)
  // Explicit entries for privileged accounts such as SYSTEM and Administrators
  // may remain. Ordinary accounts must not be present.
  expect(entries.some(entry => /^(?:Everyone|BUILTIN\\Users|(?:NT AUTHORITY\\)?Authenticated Users):\(/i.test(entry)), out).toBe(false)
  // This can catch inherited ACEs under an inheritable DACL (e.g. in a user
  // profile). On CI's D: volume a new unrestricted sidecar already has no (I).
  expect(entries.some(entry => entry.includes('(I)')), out).toBe(false)
}

it('requires a full-control entry for the current user even when the listing path contains the username', () => {
  const user = execFileSync('whoami', { encoding: 'utf-8' }).trim().split('\\').pop()!
  const target = path.join(os.tmpdir(), user, 'Everyone', 'example.jsonl')
  const listing = (entry: string) => `${target} ${entry}\r\n\r\nSuccessfully processed 1 files\r\n`

  expect(() => expectRestrictedListing(target, listing('REDLOG-ACL-TEST\\unrelated-account:(F)'))).toThrow()
  expect(() => expectRestrictedListing(target, listing(`${user}:(RX)`))).toThrow()
  expect(() => expectRestrictedListing(target, listing(`${user}:(F)\r\n  REDLOG-ACL-TEST\\unrelated-account:(I)(RX)`))).toThrow()
  expect(() => expectRestrictedListing(target, listing(`${user}:(F)\r\n  Everyone:(RX)`))).toThrow()
  expectRestrictedListing(target, listing(`${user}:(F)`))
})

describe.skipIf(!IS_WIN)('the AI sidecar directory under the real Windows ACL', () => {
  // Observe NTFS itself instead of using the recorder from test/setup.ts.
  beforeEach(() => {
    useRealIcacls()
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tailer-acl-win-'))
    initDB(scratch)
    createOperator({ id: OP, name: 'Operator 1', token: generateToken() })
    fs.mkdirSync(path.join(scratch, 'claude-projects', '-tmp-acl'), { recursive: true })
    claudeCodeAdapter.transcriptGlob = path.join(scratch, 'claude-projects', '**', '*.jsonl')
    registerAdapter(claudeCodeAdapter)
    configureHost({ enabled: true, identity: { projectId: 'p1', engagementId: 'e1', operatorId: OP }, idleFlushMs: 60_000, previewChars: 1000 })
  })

  afterEach(() => {
    stopHost()
    try { closeDB() } catch { /* ignore */ }
    fs.rmSync(scratch, { recursive: true, force: true })
  })

  it('is owner-only, keeps an earlier sidecar readable, and holds a new one the same way', () => {
    const dir = path.join(scratch, 'agent-transcripts')
    const earlier = path.join(dir, 'claude-code-earlier.jsonl')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(earlier, 'EARLIER-CONVERSATION')
    expect(aclEntries(earlier, aclListing(earlier)).some(entry => entry.startsWith('BUILTIN\\Administrators:('))).toBe(true)

    const source = path.join(scratch, 'claude-projects', '-tmp-acl', `${SID}.jsonl`)
    fs.writeFileSync(source, turn('u1', 'first'))
    registerSession('claude-code', source)
    fs.appendFileSync(source, turn('u2', 'second'))
    catchUpSession('claude-code', SID)

    const sidecar = _sessionsForTest().get(`claude-code:${SID}`)!.sidecarPath
    const seen = { dir: aclListing(dir), earlier: aclListing(earlier), sidecar: aclListing(sidecar) }
    console.log(`[ACL] dir\n${seen.dir}\n[ACL] earlier\n${seen.earlier}\n[ACL] new sidecar\n${seen.sidecar}`)

    for (const [target, out] of [[dir, seen.dir], [earlier, seen.earlier], [sidecar, seen.sidecar]]) {
      expectRestrictedListing(target, out)
    }

    expect(fs.readFileSync(earlier, 'utf-8')).toBe('EARLIER-CONVERSATION')
    expect(fs.readFileSync(sidecar, 'utf-8')).toContain('second')
  })
})
