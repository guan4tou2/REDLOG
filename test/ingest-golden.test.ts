import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

// The write path was made cheaper per insert (statements prepared once per
// connection; no FTS delete for a body the index has never seen). Neither may
// change a byte of what is stored or the chain it forms. This fixes every
// source of variation — ids, clocks, host, signature — runs a mixed input
// through ingest(), and compares a digest of every stored row of both tiers,
// the saved-body index and the chain head with one recorded from the code
// BEFORE that change. It includes repeated commands inside the 2 s window, so
// the dedup decisions are part of what is pinned.
//
// If this fails after an intended change to what is stored, the change is to
// the evidence format: say so in that commit and re-record the digest.

vi.mock('../src/core/clock', async (actual) => {
  const real = await actual<typeof import('../src/core/clock')>()
  let ns = 1_000_000n
  return { ...real, monotonicNs: () => String(ns += 1000n), getNtpOffsetMs: () => null }
})
vi.mock('../src/core/signing', async (actual) => {
  const real = await actual<typeof import('../src/core/signing')>()
  return { ...real, signEvent: (canonical: string, operator: string) => `sig:${operator}:${crypto.createHash('sha256').update(canonical).digest('hex')}` }
})

// Recorded from the write path before statement caching and the skipped FTS
// delete (2026-11-11). Re-recorded 2026-11-13 for Spec 071 T021: every new
// row now carries the receiver's stamp `data._ingest` (FR-005), which is
// inside the chained hash, and its event_id takes one randomUUID per row, so
// the ids that follow shift too. The evidence content of new rows changed.
// Re-recorded 2026-11-14 for Spec 071 T025: a row with a terminal carries it
// as `_ingest.terminal` (FR-011). With that one key held back the previous
// digest comes out unchanged, so nothing else moved.
const GOLDEN = {
  rows: '5a3ecc37b7d6b96841587aabb9550891989c01b8f0c3f4fb8b3d3fa19c41a624',
  head: '039143cb03fcfec4c55c0f68ca92ec8b231313ab3aa7c67b607c465403cec9d8'
}

let dir: string
beforeEach(() => {
  let id = 0
  vi.spyOn(crypto, 'randomUUID').mockImplementation(() => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`)
  vi.spyOn(os, 'hostname').mockReturnValue('golden-host')
  vi.useFakeTimers({ now: Date.UTC(2026, 0, 2, 3, 4, 5), toFake: ['Date'] })
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-golden-'))
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) })

describe('ingest write path, byte for byte', () => {
  it('stores the same rows, body index and chain head for a fixed input', async () => {
    const db = await import('../src/core/db/index')
    const ops = await import('../src/core/db/operators')
    const ingest = await import('../src/core/ingest')
    const bodyIndex = await import('../src/core/http-body-index')
    db.initDB(dir)
    db.bindDBEngagement('eng-golden')
    const operatorId = ops.ensurePrimaryOperator('op-golden', 'Golden', 'token-golden').id
    const results: string[] = []
    const post = (agentType: string, data: Record<string, unknown>, targetId?: string): void => {
      const r = ingest.ingest({ operatorId, engagementId: 'eng-golden', agentType, data, ...(targetId ? { targetId } : {}) })
      results.push(r.event ? `ok:${r.event.id}` : `skip:${r.skipped}`)
      vi.advanceTimersByTime(250)
    }
    const body = (text: string) => { const b = Buffer.from(text); return { data: b.toString('base64'), encoding: 'base64', size: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') } }
    for (let i = 0; i < 40; i++) {
      const ip = `10.0.0.${i % 7}`
      // Every third command repeats the previous one within 2 s.
      const command = i % 3 === 2 ? `nmap -p ${i - 1} ${`10.0.0.${(i - 1) % 7}`}` : `nmap -p ${i} ${ip}`
      post('shell', { subtype: 'command_start', command, terminalId: 't1', pid: 100 + i, command_id: `c${i}` }, ip)
      post('shell', { subtype: 'command_end', command, terminalId: 't1', pid: 100 + i, command_id: `c${i}`, exit_code: i % 2, stdout: `open ${i}\n` })
      post('scanner', { subtype: 'http_request_start', flow_id: `f${i}`, method: 'GET', url: `http://h${i % 3}.test/${i}`, request_body: body(`q=${i}`) })
      post('scanner', { subtype: 'http_response', flow_id: `f${i}`, status_code: 200, url: `http://h${i % 3}.test/${i}`, response_body: body(`<p>token${i} ${'x'.repeat(i * 300)}</p>`) })
      if (i % 4 === 0) post('agent', { subtype: 'tool_call', agent: 'claude-code', tool_name: 'Bash', tool_use_id: `u${i}`, session_id: 's1', input: { command: 'id' } })
      if (i % 5 === 0) post('loot', { subtype: 'credential', matches: [{ kind: 'password', value: `pw${i}` }] })
    }
    // Re-link one event whose body is already indexed: the prior-row path.
    const anyScanner = db.getDB().prepare("SELECT id,data FROM events_logged WHERE subtype='http_response' ORDER BY rowid LIMIT 1").get() as { id: string; data: string }
    bodyIndex.linkHttpBodyEvent({ id: anyScanner.id, data: JSON.parse(anyScanner.data), agentType: 'scanner' })

    const h = crypto.createHash('sha256')
    for (const table of ['events', 'events_logged']) {
      for (const row of db.getDB().prepare(`SELECT rowid AS _rowid,* FROM ${table} ORDER BY rowid`).all()) h.update(JSON.stringify(row) + '\n')
    }
    const index = new (await import('better-sqlite3')).default(path.join(dir, 'http-body-index.db'), { readonly: true })
    const counted = index.prepare("SELECT (SELECT COUNT(*) FROM body_event_refs WHERE status='indexed') AS refs,(SELECT COUNT(*) FROM body_fts) AS fts").get() as { refs: number; fts: number }
    expect(counted.refs, 'the fixture must index saved bodies').toBeGreaterThan(40)
    expect(counted.fts).toBeGreaterThanOrEqual(counted.refs)
    // The index's own verification columns (inode/mtime signatures) differ per run.
    for (const row of index.prepare('SELECT event_id,sha256,file,size,encoding,status,indexed_bytes,reason,kind,available_bytes FROM body_event_refs ORDER BY event_id,sha256').all()) h.update(JSON.stringify(row) + '\n')
    for (const row of index.prepare('SELECT event_id,sha256,content FROM body_fts ORDER BY event_id,sha256,rowid').all()) h.update(JSON.stringify(row) + '\n')
    index.close()
    h.update(results.join(','))
    const head = (db.getDB().prepare('SELECT hash FROM events ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as { hash: string }).hash
    const digest = h.digest('hex')
    expect(results.filter(r => r === 'skip:dedup').length, 'the fixture must exercise dedup').toBeGreaterThan(5)
    bodyIndex.closeHttpBodyIndex()
    db.closeDB()
    expect({ rows: digest, head }).toEqual(GOLDEN)
  })
})
