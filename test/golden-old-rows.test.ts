// Spec 071 T002 (US5, SC-001): rows written before Spec 071 stay exactly as
// they are, and verify exactly as they did.
//
// test/fixtures/golden-pre071 holds a project database and two bundles (one
// whole chain, one projection) written by main before Spec 071, with what the
// app's verifiers and tools/redlog-verify.py said about them
// (expected.json). How they were made is in
// test/fixtures/golden-pre071-generate.ts.
//
// Held here, against today's code and every later phase's:
//   - every stored column of every old row, and its hash, is unchanged;
//   - opening the project with current code and writing new rows through every
//     door issues no UPDATE to an old row (counted by triggers added to a copy);
//   - the app's chain walk, the app's bundle verifier and redlog-verify.py say
//     what they said;
//   - a bundle exported now carries the old rows' events.jsonl and
//     events_logged.jsonl lines byte for byte as the old export did.
// The fixture is the pre-071 record and is never regenerated. Until Spec 071
// Phase 3 this file also checked that the generator still reproduced it; T021
// changed what new rows carry (`data._ingest`), so the generator's output now
// differs by design, and that check was retired as golden-pre071-generate.ts
// said it would be. Rows written with the stamp are pinned by
// test/provenance-vectors.test.ts.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { requires } from './helpers/requires'
import {
  ENG, OP, T_START, BUNDLES, dumpRows, digestRows, appVerifyView, runPythonVerifier, unpackTo, type GoldenExpected
} from './fixtures/golden-pre071-generate'

const sqlite = requires('better-sqlite3')
const python = requires('python-cryptography')
const Database = sqlite.ok ? (await import('better-sqlite3')).default : null
const FIXTURE = path.join(__dirname, 'fixtures', 'golden-pre071')
const tmps: string[] = []
function tmp(label: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `redlog-golden-${label}-`))
  tmps.push(d)
  return d
}
function copyDir(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true })
}
/** A fresh, writable copy of a committed bundle, unpacked. */
const committedBundle = (name: string, root = FIXTURE): string =>
  unpackTo(path.join(root, `bundle-${name}.json.gz`), path.join(tmp(`bundle-${name}`), `bundle-${name}`))
const jsonl = (file: string): string[] => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
const byId = (lines: string[]): Map<string, string> => new Map(lines.map((l) => [String((JSON.parse(l) as { id: string }).id), l]))

sqlite.describe('rows written before Spec 071', () => {
  let expected: GoldenExpected
  const prevKeys = process.env.REDLOG_KEYS_DIR

  beforeAll(async () => {
    expected = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'expected.json'), 'utf8')) as GoldenExpected
    // The signer key is not part of the fixture. Verifying needs only the
    // public half, which is in the database and in operators.json.
    process.env.REDLOG_KEYS_DIR = tmp('keys')
  }, 60_000)
  afterAll(() => {
    for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true })
    if (prevKeys === undefined) delete process.env.REDLOG_KEYS_DIR
    else process.env.REDLOG_KEYS_DIR = prevKeys
  })

  it('the fixture covers what T002 asks for', () => {
    const db = new Database!(path.join(copyProject(), 'timeline.db'), { readonly: true })
    try {
      const has = (sql: string): number => (db.prepare(sql).get() as { n: number }).n
      expect({
        api: has(`SELECT COUNT(*) AS n FROM events WHERE source = 'api'`),
        spool: has(`SELECT COUNT(*) AS n FROM events WHERE source = 'spool'`),
        inProcess: has(`SELECT COUNT(*) AS n FROM events WHERE source IS NULL`),
        logged: has('SELECT COUNT(*) AS n FROM events_logged'),
        raw: has(`SELECT COUNT(*) AS n FROM events WHERE json_extract(data, '$._raw') IS NOT NULL`),
        clockAnomaly: has(`SELECT COUNT(*) AS n FROM events WHERE json_extract(data, '$._clock_anomaly') IS NOT NULL`),
        sourceTimeRejected: has(`SELECT COUNT(*) AS n FROM events WHERE json_extract(data, '$._source_time_rejected') IS NOT NULL`),
        sanitized: has('SELECT COUNT(*) AS n FROM sanitized_events'),
        seals: has(`SELECT COUNT(*) AS n FROM events WHERE subtype = 'export_sealed'`)
      }).toEqual({ api: 9, spool: 3, inProcess: 9, logged: 3, raw: 1, clockAnomaly: 1, sourceTimeRejected: 1, sanitized: 1, seals: 2 })
    } finally { db.close() }
    const kind = (name: string): unknown =>
      (JSON.parse(fs.readFileSync(path.join(committedBundle(name), 'manifest.json'), 'utf8')) as { evidence: { kind: string } }).evidence.kind
    expect([kind('complete'), kind('projection')]).toEqual(['complete-chain', 'projection'])
    expect(expected.appVerify.authentication, 'the old rows are signed').toBe('verified')
  })

  /** A writable copy of the committed project, so nothing touches the fixture. */
  function copyProject(): string {
    const d = path.join(tmp('project'), 'project')
    copyDir(path.join(FIXTURE, 'project'), d)
    return d
  }

  it('every column of every old row, and its hash, is as committed', () => {
    const db = new Database!(path.join(copyProject(), 'timeline.db'), { readonly: true })
    try {
      const got = digestRows(dumpRows(db))
      expect(got.rows).toEqual(expected.rows)
      expect(got.rowsSha256).toBe(expected.rowsSha256)
    } finally { db.close() }
  })

  describe('opened, verified, written to and exported by current code', () => {
    let projectDir = ''
    let dbMod: typeof import('../src/core/db/index')
    let verifyBefore: Record<string, unknown>
    let verifyAfter: Record<string, unknown>
    let updates = -1
    let oldRowsAfter: ReturnType<typeof digestRows>
    let complete = ''
    let projection = ''
    let newRows = 0
    let sanitizedLater: Array<{ source_event_id: string; field: string; sanitized_value: string }> = []

    beforeAll(async () => {
      projectDir = copyProject()
      // Count every UPDATE to a pinned table from here on. The append-only
      // triggers only cover the hashed columns; these cover every column.
      const raw = new Database!(path.join(projectDir, 'timeline.db'))
      sanitizedLater = raw.prepare('SELECT source_event_id, field, sanitized_value FROM sanitized_events').all() as typeof sanitizedLater
      raw.exec('CREATE TABLE golden_updates (tbl TEXT, row INTEGER)')
      for (const t of ['events', 'events_logged', 'sanitized_events', 'operators']) {
        raw.exec(`CREATE TRIGGER golden_upd_${t} AFTER UPDATE ON ${t} BEGIN INSERT INTO golden_updates VALUES ('${t}', old.rowid); END`)
      }
      raw.close()

      vi.useFakeTimers({ now: T_START + 7 * 24 * 3600_000, toFake: ['Date'] })
      dbMod = await import('../src/core/db/index')
      const ops = await import('../src/core/db/operators')
      const ingestMod = await import('../src/core/ingest')
      const events = await import('../src/core/db/events')
      const { verifyChainFullAsync } = await import('../src/core/chain-anchor')
      const { exportBundle } = await import('../src/core/bundle-export')
      const { closeHttpBodyIndex } = await import('../src/core/http-body-index')
      const { drainSpoolAsMain } = await import('./helpers/spool-drain-as-main')
      dbMod.initDB(projectDir)
      dbMod.bindDBEngagement(ENG)
      ingestMod._resetIngest()
      verifyBefore = appVerifyView(await verifyChainFullAsync() as unknown as Record<string, unknown>)

      // New rows through every door. The operator's private key is not in the
      // fixture, so they are unsigned; that is about the new rows, not the old.
      const who = { engagementId: ENG, operatorId: OP }
      const step = (): void => { vi.advanceTimersByTime(1000) }
      const before = (dbMod.getDB().prepare('SELECT (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM events_logged) AS n').get() as { n: number }).n
      step(); events.insertEvent('system', { subtype: 'session_start' }, who)
      step(); ingestMod.ingest({ agentType: 'shell', data: { subtype: 'command_start', command: 'nmap -p 443 10.0.0.6', terminalId: 't-new', pid: 9001 }, ...who, envelope: { source: 'api', mapper: { id: 'identity', version: '1' } } })
      step(); ingestMod.ingest({ agentType: 'scanner', data: { subtype: 'http_request_start', flow_id: 'f-new', method: 'GET', url: 'http://10.0.0.6/' }, ...who, envelope: { source: 'api', mapper: { id: 'identity', version: '1' } } })
      step(); ingestMod.ingestEvent('shell', { subtype: 'command_start', command: 'hostname', terminalId: 'term-new', pid: 9002, source: 'builtin-terminal' }, who)
      const spool = tmp('spool')
      fs.writeFileSync(path.join(spool, '0001.json'), JSON.stringify({ agent_type: 'shell', data: { subtype: 'command_start', command: 'ls', pid: 9003, terminalId: 't-new-spool', source_timestamp: Date.now() - 5000 }, _identity: who }))
      step(); drainSpoolAsMain(spool, who)
      newRows = (dbMod.getDB().prepare('SELECT (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM events_logged) AS n').get() as { n: number }).n - before
      ops.listOperators()

      step(); complete = exportBundle(ENG, { outRoot: tmp('reexport-complete') }).outDir
      step(); projection = exportBundle(ENG, { outRoot: tmp('reexport-projection'), scope: { targets: ['10.0.0.0/24'], personalDomains: ['127.0.0.0/8'] } }).outDir

      verifyAfter = appVerifyView(await verifyChainFullAsync() as unknown as Record<string, unknown>)
      updates = (dbMod.getDB().prepare('SELECT COUNT(*) AS n FROM golden_updates').get() as { n: number }).n
      const all = dumpRows(dbMod.getDB())
      const oldIds = Object.fromEntries(Object.entries(expected.rows).map(([t, list]) => [t, new Set(list.map((r) => r.id))]))
      oldRowsAfter = digestRows(Object.fromEntries(Object.entries(all).map(([t, list]) => [t, list.filter((r) => oldIds[t]?.has(String(r.id)))])))
      closeHttpBodyIndex()
      dbMod.closeDB()
      vi.useRealTimers()
    }, 60_000)

    it('the app\'s chain walk says what it said before any new row', () => {
      expect(verifyBefore).toEqual(expected.appVerify)
    })

    it('new rows were written through api, logged, in-process and spool', () => {
      expect(newRows).toBe(5)
    })

    it('no old row was UPDATEd, by the open, the writes or the exports', () => {
      expect(updates).toBe(0)
    })

    it('every old row is still byte for byte as committed', () => {
      expect(oldRowsAfter.rows).toEqual(expected.rows)
    })

    it('the chain still walks whole, old rows first', () => {
      expect({ ok: verifyAfter.ok, brokenAtEventId: verifyAfter.brokenAtEventId }).toEqual({ ok: true, brokenAtEventId: null })
      expect(verifyAfter.walked as number).toBeGreaterThan(expected.appVerify.walked as number)
    })

    // One row was sanitized AFTER the committed complete bundle was exported
    // (the generator sanitizes between the two exports, so that bundle stays a
    // complete chain). Its line today carries the sanitized value, as any
    // export after the sanitize does; it is held to exactly that, byte for
    // byte, rather than to the pre-sanitize line.
    const afterSanitize = (line: string): string => {
      const row = JSON.parse(line) as { id: string; data: string }
      const fields = sanitizedLater.filter((s) => s.source_event_id === row.id)
      if (fields.length === 0) return line
      const data = JSON.parse(row.data) as Record<string, unknown>
      for (const s of fields) data[s.field] = s.sanitized_value
      return JSON.stringify({ ...row, data: JSON.stringify(data) })
    }

    for (const [name, file] of [['complete', 'events.jsonl'], ['complete', 'events_logged.jsonl'], ['projection', 'events.jsonl'], ['projection', 'events_logged.jsonl']] as const) {
      it(`a ${name} export now carries the old rows' ${file} lines byte for byte`, () => {
        const committed = jsonl(path.join(committedBundle(name), file))
        const now = byId(jsonl(path.join(name === 'complete' ? complete : projection, file)))
        expect(committed.length).toBeGreaterThan(0)
        const want = name === 'complete' ? committed.map(afterSanitize) : committed
        if (name === 'complete' && file === 'events.jsonl') expect(want.filter((l, i) => l !== committed[i])).toHaveLength(1)
        const differ = want.filter((line) => now.get(String((JSON.parse(line) as { id: string }).id)) !== line)
        expect(differ, `${differ.length} of ${committed.length} old lines differ or are missing`).toEqual([])
      })
    }
  })

  it('the app\'s bundle verifier says what it said about both committed bundles', async () => {
    const { verifyBundleDir } = await import('../src/core/bundle-verify')
    for (const name of BUNDLES) {
      expect(verifyBundleDir(committedBundle(name)), name).toEqual((expected.bundleVerify as Record<string, unknown>)[name])
    }
  })

  python.it('tools/redlog-verify.py says what it said about both committed bundles', () => {
    for (const name of BUNDLES) {
      expect(runPythonVerifier(committedBundle(name)), name).toEqual(expected.pythonVerify[name])
    }
  })
})
