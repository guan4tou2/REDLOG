import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'node:child_process'
import { claudeCodeAdapter } from '../optional-plugins/claude-code/adapter'
import { registerAdapter, configureHost, registerSession, catchUpSession, stopHost, _sessionsForTest } from '../src/main/services/tailer-host'
import { initDB, closeDB } from '../src/core/db/index'
import { createOperator, generateToken } from '../src/core/db/operators'

// The same scenario as tailer-sidecar-acl.test.ts, against the real icacls.
// Windows only: it is the one test that says what NTFS ends up holding.

const IS_WIN = process.platform === 'win32'
const OP = 'operator-1'
const SID = 'aaaaaaaa-bbbb-cccc-dddd-0000000000w1'

let scratch: string

const icacls = (target: string): string => execFileSync('icacls', [target], { encoding: 'utf-8' })
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
  it('is owner-only, keeps an earlier sidecar readable, and holds a new one the same way', () => {
    const dir = path.join(scratch, 'agent-transcripts')
    const earlier = path.join(dir, 'claude-code-earlier.jsonl')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(earlier, 'EARLIER-CONVERSATION')
    expect(icacls(earlier)).toContain('BUILTIN\\Administrators')

    const source = path.join(scratch, 'claude-projects', '-tmp-acl', `${SID}.jsonl`)
    fs.writeFileSync(source, turn('u1', 'first'))
    registerSession('claude-code', source)
    fs.appendFileSync(source, turn('u2', 'second'))
    catchUpSession('claude-code', SID)

    const sidecar = _sessionsForTest().get(`claude-code:${SID}`)!.sidecarPath
    const user = process.env.USERNAME!
    const seen = { dir: icacls(dir), earlier: icacls(earlier), sidecar: icacls(sidecar) }
    console.log(`[ACL] dir\n${seen.dir}\n[ACL] earlier\n${seen.earlier}\n[ACL] new sidecar\n${seen.sidecar}`)

    // What this protects against is another ordinary account on the machine.
    // SYSTEM and Administrators can take any file whatever its ACL, and an
    // elevated process (the CI runner) creates the directory with explicit
    // entries for both, which `/inheritance:r` does not touch — so they are
    // not asserted absent here.
    for (const out of [seen.dir, seen.earlier, seen.sidecar]) {
      expect(out).toContain(user)
      expect(out).not.toContain('Everyone')
      expect(out).not.toContain('BUILTIN\\Users')
      expect(out).not.toContain('Authenticated Users')
    }
    // Nothing reaches the directory, or a file already in it, from the project
    // directory. A sidecar created afterwards may inherit — but only from this
    // directory, which the loop above has already held to the owner.
    for (const out of [seen.dir, seen.earlier]) expect(out).not.toContain('(I)')

    expect(fs.readFileSync(earlier, 'utf-8')).toBe('EARLIER-CONVERSATION')
    expect(fs.readFileSync(sidecar, 'utf-8')).toContain('second')
  })
})
