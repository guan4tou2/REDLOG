// #222: the export preview lists each file the bundle would carry, with the
// targets it is tied to, and the operator can leave any of them out.
//
// A terminal recording spans every command typed in it. RedLog does not trim
// it, so a cast whose commands touched targets A and B is labelled as
// spanning both — never as scope-clean because the event filter was.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isAttachmentId, listExportAttachments } from '../src/core/export-attachments'
import { normalizeExportRequest } from '../src/core/export-plan'

const base = { timestamp: 1, engagementId: 'e', sessionId: 's', operatorId: 'o', hostname: '', sourceIP: null, hash: null, prevHash: null, signature: null, createdAt: 1 }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ev = (id: string, agentType: string, targetId: string | null, data: Record<string, unknown>): any => ({ ...base, id, agentType, targetId, data })

describe('listExportAttachments', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-attach-'))
    for (const d of ['screenshots', 'casts', 'http-bodies']) fs.mkdirSync(path.join(dir, d))
    fs.writeFileSync(path.join(dir, 'casts', 'term-1.cast'), 'x'.repeat(10))
    fs.writeFileSync(path.join(dir, 'casts', 'term-2.cast'), 'y')
    fs.writeFileSync(path.join(dir, 'casts', 'orphan.cast'), 'z')
    fs.writeFileSync(path.join(dir, 'screenshots', 'a.jpg'), 'img')
    fs.writeFileSync(path.join(dir, 'screenshots', 'b.jpg'), 'img')
    fs.writeFileSync(path.join(dir, 'http-bodies', 'h1.body'), 'body')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const events = (): unknown[] => [
    // One terminal session moved between two targets.
    ev('c1', 'shell', '10.0.0.1', { subtype: 'command_end', terminalId: 't1', io: { stream: 'cast', ref: '/p/casts/term-1.cast', off: 0, len: 5 } }),
    ev('c2', 'shell', '10.0.0.2', { subtype: 'command_end', terminalId: 't1', io: { stream: 'cast', ref: '/p/casts/term-1.cast', off: 5, len: 5 } }),
    // Another session stayed on one.
    ev('c3', 'shell', '10.0.0.1', { subtype: 'command_end', terminalId: 't2', io: { stream: 'cast', ref: '/p/casts/term-2.cast', off: 0, len: 1 } }),
    ev('s1', 'screenshot', '10.0.0.1', { filename: 'a.jpg' }),
    ev('s2', 'screenshot', '203.0.113.9', { filename: 'b.jpg' }),
    ev('h', 'scanner', '10.0.0.1', { request_body_ref: { sha256: 'h1' }, response_body_ref: { sha256: 'gone' } })
  ]

  it('says which targets each cast spans, and never scope-drops a cast', () => {
    const rows = listExportAttachments(dir, events() as never, { scope: { targets: ['10.0.0.1', '10.0.0.2'], excludeTargets: [], personalDomains: [] }, maskOutOfScope: true })
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get('casts/term-1.cast')).toMatchObject({ kind: 'cast', targets: ['10.0.0.1', '10.0.0.2'], attribution: 'cross-target', status: 'included', source: 't1', bytes: 10 })
    expect(byId.get('casts/term-2.cast')).toMatchObject({ targets: ['10.0.0.1'], attribution: 'target' })
    expect(byId.get('casts/orphan.cast')).toMatchObject({ attribution: 'unattributed', status: 'included' })
  })

  it('drops an out-of-scope screenshot, and reports a missing body as missing', () => {
    const rows = listExportAttachments(dir, events() as never, { scope: { targets: ['10.0.0.1'], excludeTargets: [], personalDomains: [] }, maskOutOfScope: true })
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get('screenshots/a.jpg')?.status).toBe('included')
    expect(byId.get('screenshots/b.jpg')?.status).toBe('excluded-out-of-scope')
    expect(byId.get('http-bodies/h1.body')?.status).toBe('included')
    expect(byId.get('http-bodies/gone.body')).toMatchObject({ status: 'missing', bytes: null })
  })

  it('marks what the operator left out, without touching the file', () => {
    const rows = listExportAttachments(dir, events() as never, { exclude: new Set(['casts/term-1.cast']) })
    expect(rows.find((r) => r.id === 'casts/term-1.cast')?.status).toBe('excluded-by-operator')
    expect(fs.existsSync(path.join(dir, 'casts', 'term-1.cast'))).toBe(true)
  })
})

describe('excluding attachments from an export request', () => {
  it('keeps only well-formed bundle paths, sorted and unique, so the fingerprint is stable', () => {
    const req = normalizeExportRequest({
      format: 'bundle',
      excludeAttachments: ['casts/b.cast', 'casts/a.cast', 'casts/a.cast', '../etc/passwd', 'casts/../x', 'events.jsonl', 'screenshots/s.jpg']
    })
    expect(req.excludeAttachments).toEqual(['casts/a.cast', 'casts/b.cast', 'screenshots/s.jpg'])
    expect(isAttachmentId('http-bodies/abc.body')).toBe(true)
    expect(isAttachmentId('manifest.json')).toBe(false)
  })
})
