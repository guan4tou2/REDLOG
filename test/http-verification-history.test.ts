import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HttpVerificationHistory } from '../src/main/services/http-verification-history'
import { httpVerificationState, type HttpVerificationEvidence, type HttpVerificationContext } from '../src/core/http-verification-evidence'

const evidence: HttpVerificationEvidence = { version: 1, projectId: 'a', clientIdentity: null, clientLabel: 'curl/8', endpoint: 'http://127.0.0.1:8080', caFingerprint: 'aa', routing: '[false]', sourceInstance: 'process-a', verifiedAt: 1000, captureVerified: true, caTrustVerified: false }
const current: HttpVerificationContext = { projectId: 'a', clientIdentity: null, endpoint: evidence.endpoint, caFingerprint: 'aa', routing: '[false]', sourceInstance: 'process-a', running: true, failed: false }
const dirs: string[] = []
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-http-history-')); dirs.push(dir); return dir }
afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })))

describe('HTTP verification evidence and current state', () => {
  it.each([
    [null, { ...current, projectId: '' }, false, 'not-configured'],
    [null, current, false, 'ready-to-verify'],
    [evidence, current, false, 'previously-verified'],
    [{ ...evidence, clientIdentity: 'owned-client-a' }, { ...current, clientIdentity: 'owned-client-a' }, false, 'verified-current-configuration'],
    [evidence, { ...current, routing: '[true]' }, false, 'invalidated'],
    [evidence, { ...current, failed: true }, false, 'failed'],
    [evidence, current, true, 'unknown']
  ] as const)('keeps the seven distinct states (%s)', (saved, context, unreadable, expected) => {
    expect(httpVerificationState(saved, context, unreadable)).toBe(expected)
  })

  it.each(['projectId', 'endpoint', 'caFingerprint', 'routing'] as const)('invalidates changed %s', key => {
    expect(httpVerificationState(evidence, { ...current, [key]: 'changed' })).toBe('invalidated')
  })

  it('does not inherit proof across client identity, source restart or missing CA', () => {
    const owned = { ...evidence, clientIdentity: 'owned-a' }
    expect(httpVerificationState(owned, { ...current, clientIdentity: 'owned-b' })).toBe('previously-verified')
    expect(httpVerificationState(owned, { ...current, clientIdentity: 'owned-a', sourceInstance: 'new-process' })).toBe('previously-verified')
    expect(httpVerificationState(owned, { ...current, caFingerprint: null })).toBe('unknown')
  })

  it('survives a store restart, stays project local and keeps only twenty results', () => {
    const a = temp(); const b = temp(); const store = new HttpVerificationHistory()
    for (let i = 1; i <= 25; i++) store.append(a, { ...evidence, verifiedAt: i })
    const rows = new HttpVerificationHistory().read(a)
    expect(rows).toHaveLength(20)
    expect(rows[0].verifiedAt).toBe(6)
    expect(rows.at(-1)).toEqual({ ...evidence, verifiedAt: 25 })
    expect(store.read(b)).toEqual([])
    expect(httpVerificationState(rows.at(-1)!, { ...current, sourceInstance: 'after-restart' })).toBe('previously-verified')
  })

  it('does not replace corrupt history or interpret it as no previous proof', () => {
    const dir = temp(); const file = path.join(dir, 'http-verification.json')
    fs.writeFileSync(file, 'original malformed history')
    const store = new HttpVerificationHistory()
    expect(() => store.read(dir)).toThrow()
    expect(() => store.append(dir, evidence)).toThrow()
    expect(fs.readFileSync(file, 'utf8')).toBe('original malformed history')
  })
})
