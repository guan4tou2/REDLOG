// Spec 071 FR-012, for the attachment digests a bundle is checked against.
//
// A `shell.session_end` names the cast files of a recording and the sha256 of
// each (`castSegments`, or `castPath` + `castSha256` before segments). Both
// verifiers — the app's (evidence-rules.ts attachmentRefs, used by
// bundle-verify.ts) and the recipient's (tools/redlog-verify.py
// attachment_refs) — check every file a row names against the digest it
// names, and the export picks attachments by them (bundle-export.ts). Those
// rows are written in-process by terminal-manager.ts. A `session_end` posted
// to the API was read the same way, so any token holder could name a genuine
// recording's cast with a wrong digest and make every bundle of the project
// report ATTACHMENT MISMATCH on it.
//
// A stamped `session_end` now names casts only when `_ingest.producer` is
// `in-process`; one without a stamp (written before Spec 071) is read as
// before. The two verifiers are held to the same answer on one vector.

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { requires } from './helpers/requires'
import { attachmentRefs } from '../src/core/evidence-rules'
import { DERIVED, IN_PROCESS, LEGACY_API, LEGACY_HANDOFF, ingestStamp, type IngestEntrance } from '../src/core/ingest/stamp'
import { VERIFIER, pythonBin, runPythonVerifier } from './fixtures/golden-pre071-generate'

const sqlite = requires('better-sqlite3')
const python = requires('python-cryptography')

const SHA = 'a'.repeat(64)
const stamped = (e: IngestEntrance) => ingestStamp(e, { tier: 'chained', now: Date.UTC(2026, 10, 14) })
const segmentsEnd = { subtype: 'session_end', source: 'builtin-terminal', castSegments: [{ path: '/p/casts/r1.cast', bytes: 10, sha256: SHA }] }
const singleEnd = { subtype: 'session_end', source: 'builtin-terminal', castPath: '/p/casts/r2.cast', castSha256: SHA, castBytes: 5 }

const VECTOR: Array<{ label: string; agentType: string; data: Record<string, unknown>; casts: string[] }> = [
  { label: 'no stamp (before 071), segments', agentType: 'shell', data: segmentsEnd, casts: ['casts/r1.cast'] },
  { label: 'no stamp (before 071), one file', agentType: 'shell', data: singleEnd, casts: ['casts/r2.cast'] },
  { label: 'in-process, segments', agentType: 'shell', data: { ...segmentsEnd, _ingest: stamped(IN_PROCESS) }, casts: ['casts/r1.cast'] },
  { label: 'in-process, one file', agentType: 'shell', data: { ...singleEnd, _ingest: stamped(IN_PROCESS) }, casts: ['casts/r2.cast'] },
  { label: 'legacy-api, segments', agentType: 'shell', data: { ...segmentsEnd, _ingest: stamped(LEGACY_API) }, casts: [] },
  { label: 'legacy-api, one file', agentType: 'shell', data: { ...singleEnd, _ingest: stamped(LEGACY_API) }, casts: [] },
  { label: 'legacy-handoff', agentType: 'shell', data: { ...segmentsEnd, _ingest: stamped(LEGACY_HANDOFF) }, casts: [] },
  { label: 'derived', agentType: 'shell', data: { ...segmentsEnd, _ingest: stamped(DERIVED) }, casts: [] },
  { label: 'a stamp that is not an object', agentType: 'shell', data: { ...segmentsEnd, _ingest: null }, casts: [] },
  // Other attachment kinds are not the terminal's, and are not changed.
  { label: 'a screenshot through the API', agentType: 'screenshot', data: { filename: 's.jpg', sha256: SHA, size: 3, _ingest: stamped(LEGACY_API) }, casts: [] }
]
const castPaths = (refs: Array<{ path: string }>): string[] => refs.map((r) => r.path).filter((p) => p.startsWith('casts/'))

describe('which session_end names cast digests', () => {
  for (const v of VECTOR) {
    it(`app verifier: ${v.label}`, () => {
      expect(castPaths(attachmentRefs(v.agentType, v.data))).toEqual(v.casts)
    })
  }
  it('the screenshot row keeps its own ref', () => {
    expect(attachmentRefs('screenshot', VECTOR.at(-1)!.data).map((r) => r.path)).toEqual(['screenshots/s.jpg'])
  })

  python.it('tools/redlog-verify.py gives the same answer for every row of the vector', () => {
    const driver = [
      'import importlib.util, json, sys',
      'spec = importlib.util.spec_from_file_location("rv", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'print(json.dumps([[r["path"] for r in m.attachment_refs(c["agentType"], c["data"]) if r["path"].startswith("casts/")] for c in json.load(sys.stdin)]))'
    ].join('\n')
    const r = spawnSync(pythonBin, ['-I', '-c', driver, VERIFIER], { input: JSON.stringify(VECTOR), encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual(VECTOR.map((v) => v.casts))
  })
})

// The attack end to end: a genuine recording, and a posted end that names its
// cast with a wrong digest. Both verifiers must still bind the genuine cast.
sqlite.describe('an exported bundle with a posted session_end', () => {
  let dir = ''
  let keys = ''
  const prevKeys = process.env.REDLOG_KEYS_DIR
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-attref-'))
    keys = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-attref-keys-'))
    process.env.REDLOG_KEYS_DIR = keys
  })
  afterEach(async () => {
    ;(await import('../src/core/db/index')).closeDB()
    for (const d of [dir, keys]) fs.rmSync(d, { recursive: true, force: true })
    if (prevKeys === undefined) delete process.env.REDLOG_KEYS_DIR
    else process.env.REDLOG_KEYS_DIR = prevKeys
  })

  async function exportWithForgedEnd(): Promise<string> {
    const db = await import('../src/core/db/index')
    const { insertEvent } = await import('../src/core/db/events')
    const { exportBundle } = await import('../src/core/bundle-export')
    db.initDB(dir)
    db.bindDBEngagement('eng')
    const ids = { engagementId: 'eng', operatorId: 'op' }
    fs.mkdirSync(path.join(dir, 'casts'), { recursive: true })
    const cast = path.join(dir, 'casts', 'rec-genuine.cast')
    fs.writeFileSync(cast, '{"version":2,"timestamp":1}\n[0.5,"o","genuine"]\n')
    const digest = crypto.createHash('sha256').update(fs.readFileSync(cast)).digest('hex')
    const bytes = fs.statSync(cast).size
    insertEvent('shell', { subtype: 'session_start', source: 'builtin-terminal', terminalId: 't', recordingId: 'rec-genuine', castPath: cast }, ids)
    insertEvent('shell', { subtype: 'session_end', source: 'builtin-terminal', terminalId: 't', recordingId: 'rec-genuine', castPath: cast,
      castSha256: digest, castSegments: [{ path: cast, bytes, sha256: digest }], castBytes: bytes }, ids)
    // What POST /api/events writes for a token holder.
    insertEvent('shell', { subtype: 'session_end', source: 'builtin-terminal', terminalId: 't', recordingId: 'rec-genuine',
      castSegments: [{ path: cast, bytes, sha256: 'f'.repeat(64) }] }, { ...ids, entrance: LEGACY_API })
    return exportBundle('eng', {}).outDir
  }

  it('the app\'s verifier binds the genuine cast and reports no mismatch', async () => {
    const out = await exportWithForgedEnd()
    const { verifyBundleDir } = await import('../src/core/bundle-verify')
    const got = verifyBundleDir(out)
    expect(got.problems.filter((p) => p.includes('ATTACHMENT'))).toEqual([])
    expect(got.attachments?.bound ?? []).toContain('casts/rec-genuine.cast')
  })

  python.it('tools/redlog-verify.py (the copy every bundle embeds) agrees', async () => {
    const out = await exportWithForgedEnd()
    const r = runPythonVerifier(out)
    expect(r.stdout).not.toContain('ATTACHMENT MISMATCH')
    expect(r.status, r.stdout).not.toBe(4)
  })
})
