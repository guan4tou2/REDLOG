import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { claudeCodeAdapter } from '../optional-plugins/claude-code/adapter'
import { registerAdapter, configureHost, registerSession, catchUpSession, stopHost, _sessionsForTest } from '../src/main/services/tailer-host'
import { eventBus } from '../src/core/event-bus'
import { initDB, closeDB } from '../src/core/db/index'
import { createOperator, generateToken } from '../src/core/db/operators'
import { aclEntries, aclListing, isCurrentUser, useRealIcacls } from './helpers/icacls'

// The same scenario as tailer-sidecar-acl.test.ts, against the real icacls.
// Windows only: it is the one test that says what NTFS ends up holding, so it
// runs icacls itself instead of test/setup.ts's record.
useRealIcacls()

const IS_WIN = process.platform === 'win32'
const OP = 'operator-1'
const SID = 'aaaaaaaa-bbbb-cccc-dddd-0000000000w1'

let scratch: string

const turn = (uuid: string, text: string): string => JSON.stringify({
  type: 'user', uuid, cwd: '/tmp/acl',
  message: { role: 'user', content: [{ type: 'text', text }] }
}) + '\n'

beforeEach(() => {
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

describe.skipIf(!IS_WIN)('the AI sidecar directory under the real Windows ACL', () => {
  it('keeps an earlier sidecar readable and gives new files inherited owner access', () => {
    const dir = path.join(scratch, 'agent-transcripts')
    const earlier = path.join(dir, 'claude-code-earlier.jsonl')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(earlier, 'EARLIER-CONVERSATION')

    const source = path.join(scratch, 'claude-projects', '-tmp-acl', `${SID}.jsonl`)
    fs.writeFileSync(source, turn('u1', 'first'))
    registerSession('claude-code', source)
    fs.appendFileSync(source, turn('u2', 'second'))
    catchUpSession('claude-code', SID)

    const sidecar = _sessionsForTest().get(`claude-code:${SID}`)!.sidecarPath
    eventBus.pause()
    eventBus.resume()
    const plain = path.join(dir, 'plain.txt')
    fs.writeFileSync(plain, 'created by plain writeFileSync')

    const entries = (label: string, target: string): string[] => {
      const out = aclListing(target)
      console.log(`[ACL] ${label}\n${out}`)
      return aclEntries(target, out)
    }
    const dirEntries = entries('directory', dir)
    const earlierEntries = entries('earlier sidecar', earlier)
    const newEntries = [
      entries('new sidecar', sidecar),
      entries('new offset cursor', sidecar + '.offset.json'),
      entries('recording boundary', path.join(dir, '.recording-boundary.json')),
      entries('plain writeFileSync file', plain)
    ]
    const principals = (acl: string[]): string[] => acl.map((entry) => entry.slice(0, entry.lastIndexOf(':(')))
    for (const acl of newEntries) {
      const names = principals(acl)
      console.log('[ACL] possible token default principals', {
        fileEntries: acl,
        Administrators: names.includes('BUILTIN\\Administrators'),
        SYSTEM: names.includes('NT AUTHORITY\\SYSTEM'),
        LogonSessionId: names.some((name) => /^(?:NT AUTHORITY\\)?LogonSessionId|^S-1-5-5-/i.test(name))
      })
    }

    for (const acl of [dirEntries, earlierEntries, ...newEntries]) {
      const names = principals(acl)
      for (const other of ['Everyone', 'BUILTIN\\Users', 'NT AUTHORITY\\Authenticated Users', 'Authenticated Users']) {
        expect(names).not.toContain(other)
      }
    }
    expect(dirEntries.some((entry) => entry.endsWith(':(OI)(CI)(F)') && isCurrentUser(entry)), dirEntries.join('\n')).toBe(true)
    expect(earlierEntries.some((entry) => entry.endsWith(':(F)') && isCurrentUser(entry)), earlierEntries.join('\n')).toBe(true)
    for (const acl of [dirEntries, earlierEntries]) expect(acl.some((entry) => entry.includes('(I)'))).toBe(false)

    // Without the inheritable grant, an unrestricted new file under the
    // elevated runner has Administrators, SYSTEM and LogonSessionId, but no
    // current-user entry. The inherited full-control assertion is the one
    // that can fail even when the broad principals are absent.
    for (const acl of newEntries) {
      expect(acl.some((entry) => entry.endsWith(':(I)(F)') && isCurrentUser(entry)), acl.join('\n')).toBe(true)
    }

    expect(fs.readFileSync(earlier, 'utf-8')).toBe('EARLIER-CONVERSATION')
    expect(fs.readFileSync(sidecar, 'utf-8')).toContain('second')
  })
})
