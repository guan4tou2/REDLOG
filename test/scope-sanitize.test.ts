import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { scopeRedactionPlaceholder } from '../src/core/scope-sanitize'

// Scope-aware sanitize execution (SPEC-SCOPE-AWARE-LIFECYCLE.md Part B). The
// placeholder is pure and always testable; the orchestrator + export swap are
// DB-backed and guarded (skip when better-sqlite3 isn't built for this Node).

describe('scopeRedactionPlaceholder (pure)', () => {
  it('names the touched host while removing content (A1)', () => {
    expect(scopeRedactionPlaceholder('out_of_scope', 'evil.com')).toBe('[redacted: out-of-scope — evil.com]')
    expect(scopeRedactionPlaceholder('excluded', 'secret.example.com')).toBe('[redacted: excluded target — secret.example.com]')
    expect(scopeRedactionPlaceholder('unknown', null)).toBe('[redacted: unclassified target]')
  })
  it('is empty for in_scope (never sanitized)', () => {
    expect(scopeRedactionPlaceholder('in_scope', 'app.example.com')).toBe('')
  })
})

// --- DB-backed round trip ---
let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let insertEvent: typeof import('../src/core/db/events').insertEvent
let queryEvents: typeof import('../src/core/db/events').queryEvents
let putBody: typeof import('../src/core/io-store').putBody
let runScopeSanitize: typeof import('../src/core/scope-sanitize').runScopeSanitize
let getSanitizedIo: typeof import('../src/core/scope-sanitize').getSanitizedIo
let getSanitizedFields: typeof import('../src/core/sanitize').getSanitizedFields
let exportBundle: typeof import('../src/core/bundle-export').exportBundle
let classifyTarget: typeof import('../src/core/scope-monitor').classifyTarget
let dbAvailable = false
try {
  initDB = (await import('../src/core/db/index')).initDB
  closeDB = (await import('../src/core/db/index')).closeDB
  insertEvent = (await import('../src/core/db/events')).insertEvent
  queryEvents = (await import('../src/core/db/events')).queryEvents
  putBody = (await import('../src/core/io-store')).putBody
  const ss = await import('../src/core/scope-sanitize')
  runScopeSanitize = ss.runScopeSanitize; getSanitizedIo = ss.getSanitizedIo
  getSanitizedFields = (await import('../src/core/sanitize')).getSanitizedFields
  exportBundle = (await import('../src/core/bundle-export')).exportBundle
  classifyTarget = (await import('../src/core/scope-monitor')).classifyTarget
  dbAvailable = true
} catch { /* native module unavailable */ }
const describeDB = dbAvailable ? describe : describe.skip

const OPTS = { engagementId: 'eng', operatorId: 'op' }
const SCOPE = { targets: ['*.example.com'], excludeTargets: [] }
const classify = (t: string | null) => classifyTarget(t, SCOPE)

describeDB('runScopeSanitize', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-ss-')); initDB(dir) })
  afterEach(() => { closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  const seedHttp = (target: string, bodyText: string): string => {
    const { ref } = putBody(dir, Buffer.from(bodyText, 'utf8'))
    insertEvent('scanner', {
      subtype: 'http_response', url: `http://${target}/x`, host: target, status: 200,
      response_preview: bodyText.slice(0, 100),
      io: { response: { ref, len: bodyText.length, sha256: ref } }
    }, { ...OPTS, targetId: target })
    return ref
  }

  it('sanitizes out-of-scope inline fields + io body, keeps in-scope (A1)', () => {
    const inRef = seedHttp('app.example.com', 'IN SCOPE BODY '.repeat(2000))
    const outRef = seedHttp('evil.com', 'OUT OF SCOPE SECRET '.repeat(2000))
    const events = queryEvents({ limit: 100 })
      .map((e) => ({ id: e.id, targetId: e.targetId, data: e.data }))
    const res = runScopeSanitize({ events, classify, ...OPTS })

    expect(res.sanitizedFields).toBeGreaterThanOrEqual(1)
    expect(res.sanitizedIoBodies).toBe(1)
    expect(res.sanitizedEventId).toBeTruthy()

    // out-of-scope io body has a redacted replacement; in-scope one does not
    const io = getSanitizedIo()
    expect(io.has(outRef)).toBe(true)
    expect(io.has(inRef)).toBe(false)
    expect(io.get(outRef)!.value).toContain('out-of-scope')
    // replacement digest is the sha of the placeholder, not the original
    expect(io.get(outRef)!.replacementSha).toBe(crypto.createHash('sha256').update(io.get(outRef)!.value).digest('hex'))
  })

  it('never sanitizes unknown-target events by default (A2)', () => {
    seedHttp('evil.com', 'body '.repeat(2000))
    insertEvent('shell', { subtype: 'command_end', command: 'ls', output: 'X'.repeat(200), redactions: [] }, OPTS) // no target
    const events = queryEvents({ limit: 100 })
      .map((e) => ({ id: e.id, targetId: e.targetId, data: e.data }))
    const res = runScopeSanitize({ events, classify, ...OPTS })
    expect(res.plan.unknown.length).toBeGreaterThanOrEqual(1)
    // the unknown shell event is flagged, not sanitized
    expect(res.plan.toSanitize.every((i) => i.scope !== 'unknown')).toBe(true)
  })

  it('client-deliverable export serves the redacted io body; verify would see it as sanitized', () => {
    const outRef = seedHttp('evil.com', 'LEAKED '.repeat(3000))
    const { outDir, manifest } = exportBundle('eng', {
      outRoot: path.join(dir, 'exp'), profile: 'client-deliverable', scope: SCOPE, operatorId: 'op'
    })
    // the bundle io file exists under the ORIGINAL name but holds the replacement
    const bundled = fs.readFileSync(path.join(outDir, 'io', `${outRef}.bin`), 'utf8')
    expect(bundled).toContain('out-of-scope')
    // manifest sha == sha of the replacement bytes (not the original)
    const entry = manifest.files.find((f) => f.path === `io/${outRef}.bin`)!
    expect(entry.sha256).toBe(crypto.createHash('sha256').update(bundled).digest('hex'))
    // and a system.sanitized event recorded the swap (proves it's audited)
    const events = fs.readFileSync(path.join(outDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const san = events.find((e) => e.agent_type === 'system' && JSON.parse(e.data).subtype === 'sanitized')
    expect(san, 'system.sanitized event in bundle').toBeTruthy()
    expect(JSON.parse(san.data).io_replacements.some((r: { ref: string }) => r.ref === outRef)).toBe(true)
  })
})
