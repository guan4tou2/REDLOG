// #221: an operator adds a local file as evidence. RedLog copies it into the
// project, hashes the copy, and the bundle carries it only with the event
// that added it. A command in the file's folder while it was written is a
// possible relationship, never proof.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { addArtifact, artifactRelatedCommands, safeArtifactName } from '../src/core/artifacts'
import { listExportAttachments, storedArtifactOf } from '../src/core/export-attachments'
import { countExportAttachments } from '../src/core/export-plan'
import { artifactToast } from '../src/renderer/src/lib/addArtifacts'

const base = { timestamp: 1, engagementId: 'e', sessionId: 's', operatorId: 'o', hostname: '', sourceIP: null, hash: null, prevHash: null, signature: null, createdAt: 1 }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ev = (id: string, agentType: string, targetId: string | null, data: Record<string, unknown>, timestamp = 1): any => ({ ...base, id, timestamp, agentType, targetId, data })
const t = (key: string, vars?: Record<string, string | number>): string => `${key}${vars ? JSON.stringify(vars) : ''}`

describe('addArtifact', () => {
  let project: string
  let outside: string
  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-proj-'))
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-loot-'))
  })
  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it('copies the file into artifacts/ and records the hash of the copy', () => {
    const src = path.join(outside, 'nmap report.xml')
    fs.writeFileSync(src, '<nmaprun/>')
    const r = addArtifact(project, src)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const sha = createHash('sha256').update('<nmaprun/>').digest('hex')
    expect(r).toMatchObject({ sha256: sha, bytes: 10, originalPath: src, duplicate: false })
    expect(r.stored).toBe(`artifacts/${sha.slice(0, 12)}-nmap_report.xml`)
    expect(fs.readFileSync(path.join(project, r.stored), 'utf8')).toBe('<nmaprun/>')
    // Nothing half-written is left behind.
    expect(fs.readdirSync(path.join(project, 'artifacts')).filter((n) => n.startsWith('.incoming'))).toEqual([])
  })

  it('says a second add of the same bytes is a duplicate and copies nothing new', () => {
    const src = path.join(outside, 'a.txt')
    fs.writeFileSync(src, 'same')
    addArtifact(project, src)
    const again = addArtifact(project, src)
    expect(again).toMatchObject({ ok: true, duplicate: true })
    expect(fs.readdirSync(path.join(project, 'artifacts'))).toHaveLength(1)
  })

  it('refuses a file over the size limit, a directory, and a missing path — visibly', () => {
    const big = path.join(outside, 'big.bin')
    fs.writeFileSync(big, Buffer.alloc(64))
    expect(addArtifact(project, big, { maxBytes: 10 })).toMatchObject({ ok: false, error: 'too-large', bytes: 64 })
    expect(addArtifact(project, outside)).toMatchObject({ ok: false, error: 'not-a-file' })
    expect(addArtifact(project, path.join(outside, 'nope'))).toMatchObject({ ok: false, error: 'unreadable' })
    expect(fs.existsSync(path.join(project, 'artifacts'))).toBe(false)
  })

  it('keeps stored names inside the folder', () => {
    expect(safeArtifactName('../../etc/passwd')).toBe('passwd')
    expect(safeArtifactName('..hidden')).toBe('hidden')
    expect(safeArtifactName('')).toBe('file')
  })
})

describe('artifactRelatedCommands', () => {
  const file = path.resolve('/work/loot/out.txt')
  const shell = [
    // ran in the file's folder, 10:00:00–10:00:05; the file was written at 10:00:04
    ev('in', 'shell', null, { subtype: 'command_end', cwd: path.resolve('/work'), duration_sec: 5 }, 105_000),
    // same folder, finished long before
    ev('early', 'shell', null, { subtype: 'command_end', cwd: path.resolve('/work'), duration_sec: 1 }, 50_000),
    // right time, different folder
    ev('elsewhere', 'shell', null, { subtype: 'command_end', cwd: path.resolve('/tmp'), duration_sec: 5 }, 105_000),
    // a start row carries no duration
    ev('start', 'shell', null, { subtype: 'command_start', cwd: path.resolve('/work') }, 100_000)
  ]
  it('lists only commands in a folder holding the file that were running when it was written', () => {
    expect(artifactRelatedCommands(file, 104_000, shell)).toEqual([{ event_id: 'in', method: 'cwd-and-time-overlap' }])
  })
})

describe('artifacts in the export', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-attach-art-'))
    fs.mkdirSync(path.join(dir, 'artifacts'))
    fs.writeFileSync(path.join(dir, 'artifacts', 'aaa-report.xml'), 'report')
    fs.writeFileSync(path.join(dir, 'artifacts', 'bbb-client-b.txt'), 'b')
    fs.writeFileSync(path.join(dir, 'artifacts', 'ccc-unreferenced.txt'), 'c')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const events = (): unknown[] => [
    ev('a1', 'file_transfer', '10.0.0.1', { subtype: 'artifact_added', stored: 'artifacts/aaa-report.xml' }),
    ev('a2', 'file_transfer', '203.0.113.9', { subtype: 'artifact_added', stored: 'artifacts/bbb-client-b.txt' }),
    ev('a3', 'file_transfer', '10.0.0.1', { subtype: 'artifact_added', stored: 'artifacts/gone.bin' }),
    // Anything that is not an operator add, or points outside artifacts/, is ignored.
    ev('w', 'file_transfer', '10.0.0.1', { subtype: 'file_created', stored: 'artifacts/ccc-unreferenced.txt' }),
    ev('x', 'file_transfer', '10.0.0.1', { subtype: 'artifact_added', stored: '../secrets.txt' })
  ]
  const scope = { targets: ['10.0.0.1'], excludeTargets: [], personalDomains: [] }

  it('lists each referenced artifact with its target, and drops out-of-scope ones under masking', () => {
    const rows = listExportAttachments(dir, events() as never, { scope, maskOutOfScope: true })
      .filter((r) => r.kind === 'artifact')
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      ['artifacts/aaa-report.xml', 'included'],
      ['artifacts/bbb-client-b.txt', 'excluded-out-of-scope'],
      ['artifacts/gone.bin', 'missing']
    ])
    expect(rows[0]).toMatchObject({ targets: ['10.0.0.1'], attribution: 'target', bytes: 6 })
  })

  it('counts the same files the list shows, including an operator exclusion', () => {
    const counts = countExportAttachments(dir, events() as never, { scope, maskOutOfScope: true, exclude: new Set(['artifacts/aaa-report.xml']) })
    expect(counts).toMatchObject({ included: 0, missing: 1, excludedByOperator: 1 })
    expect(countExportAttachments(dir, events() as never, {})).toMatchObject({ included: 2, missing: 1 })
  })

  it('only an artifact_added event inside artifacts/ names a stored file', () => {
    const [a1, , , w, x] = events() as never[]
    expect(storedArtifactOf(a1)).toBe('artifacts/aaa-report.xml')
    expect(storedArtifactOf(w)).toBeNull()
    expect(storedArtifactOf(x)).toBeNull()
  })
})

describe('artifactToast', () => {
  const ok = { ok: true as const, stored: 'artifacts/x-a.txt', sha256: 'f'.repeat(64), bytes: 1, originalPath: '/l/a.txt', mtime: 1, duplicate: false, eventId: 'e1', relatedCommands: 0 }
  it('reports every outcome, never silently', () => {
    expect(artifactToast(ok, t)).toMatchObject({ type: 'success', message: 'artifacts.added{"name":"a.txt"}' })
    expect(artifactToast({ ...ok, relatedCommands: 2 }, t).why).toBe('artifacts.related{"count":2}')
    expect(artifactToast({ ...ok, duplicate: true }, t).type).toBe('info')
    expect(artifactToast({ ...ok, eventId: null }, t)).toMatchObject({ type: 'error', message: 'artifacts.notRecorded{"name":"a.txt"}' })
    expect(artifactToast({ ok: false, error: 'too-large', originalPath: 'C:\\l\\big.bin', bytes: 300 * 1024 * 1024 }, t))
      .toMatchObject({ type: 'warning', message: 'artifacts.tooLarge{"name":"big.bin"}', why: 'artifacts.tooLargeWhy{"size":"300.0 MB"}' })
    expect(artifactToast({ ok: false, error: 'no-space', originalPath: '/l/a' }, t).type).toBe('error')
    expect(artifactToast({ ok: false, error: 'copy-failed', originalPath: '/l/a', detail: 'EIO' }, t)).toMatchObject({ type: 'error', detail: 'EIO' })
  })
})
