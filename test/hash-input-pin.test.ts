// Spec 071 T005: what a chained row's hash covers, pinned in all three places
// that compute it, plus the durability setting the receipt contract leans on.
//
//   1. the writer — insertChainedEvent in src/core/db/event-write.ts hashes
//      `canonicalStringify({ ...event, hash: undefined, prevHash })`;
//   2. the app's verifier walk — chainedRowCanonical in
//      src/core/evidence-rules.ts, used by verifyChainFullAsync and
//      verifyRandomSample in chain-anchor.ts (the task text names
//      `chain-anchor.canonicalHashPayload`, which no longer exists: the payload
//      moved to evidence-rules.ts so the bundle verifier shares it);
//   3. the recipient's verifier — `_rebuild_shapes` in tools/redlog-verify.py.
//
// Spec 071 keeps the hash formula and puts provenance under `data._ingest`
// (plan D1). That only works while the three agree on exactly this key set, and
// while `data` is the one place new content can go. A key added at the top
// level in one place and not the others breaks every verifier the bundle meets.
//
// The writer is pinned two ways: the event object it returns (minus the three
// fields set after hashing) has these keys, and the stored hash is the sha256
// of exactly these keys rebuilt from the stored columns. A key the writer
// hashes but does not store would fail the second; one it stores but does not
// hash would fail the first.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requires } from './helpers/requires'

const HASHED_KEYS = [
  'agentType', 'createdAt', 'data', 'engagementId', 'hostname', 'id', 'monotonicNs', 'ntpOffsetMs',
  'operatorId', 'prevHash', 'sessionId', 'sourceIP', 'targetId', 'tier', 'timestamp'
]
/** Set on the returned event after the hash is taken, so never inside it. */
const SET_AFTER_HASH = ['hash', 'rowId', 'signature']

const sqlite = requires('better-sqlite3')
const python = requires('python-cryptography')
const VERIFIER = path.resolve(__dirname, '..', 'tools', 'redlog-verify.py')
const pythonBin = ['python3', 'python'].find((bin) => spawnSync(bin, ['--version']).status === 0) ?? 'python3'

let dbMod: typeof import('../src/core/db/index')
let events: typeof import('../src/core/db/events')
let ops: typeof import('../src/core/db/operators')
let rules: typeof import('../src/core/evidence-rules')
let anchor: typeof import('../src/core/chain-anchor')
if (sqlite.ok) {
  dbMod = await import('../src/core/db/index')
  events = await import('../src/core/db/events')
  ops = await import('../src/core/db/operators')
  rules = await import('../src/core/evidence-rules')
  anchor = await import('../src/core/chain-anchor')
}

type Row = Record<string, unknown> & { hash: string; data: string; signature: string | null }

sqlite.describe('hash input of a chained row', () => {
  let dir = ''
  let keysDir = ''
  const prevKeys = process.env.REDLOG_KEYS_DIR
  let returned: Record<string, unknown>
  let row: Row
  let pubKey: string

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-hashpin-'))
    keysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-hashpin-keys-'))
    process.env.REDLOG_KEYS_DIR = keysDir
    dbMod.initDB(dir)
    dbMod.bindDBEngagement('eng-pin')
    // Keys are minted at run time into a temporary directory.
    const op = ops.createOperator({ id: 'op-pin', name: 'Pin', token: ops.generateToken(), isPrimary: true })
    pubKey = op.signerPubKey!
    events.insertEvent('system', { subtype: 'session_start' }, { engagementId: 'eng-pin', operatorId: 'op-pin' })
    const ev = events.insertEvent('shell', { subtype: 'command_start', command: 'id', terminalId: 't1' }, {
      engagementId: 'eng-pin', operatorId: 'op-pin', targetId: '10.0.0.1',
      envelope: { source: 'api', mapper: { id: 'identity', version: '1' } }
    })
    expect(ev).not.toBeNull()
    returned = ev as unknown as Record<string, unknown>
    row = dbMod.getDB().prepare('SELECT * FROM events WHERE id = ?').get(ev!.id) as Row
  })
  afterAll(() => {
    dbMod.closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(keysDir, { recursive: true, force: true })
    if (prevKeys === undefined) delete process.env.REDLOG_KEYS_DIR
    else process.env.REDLOG_KEYS_DIR = prevKeys
  })

  /** The pinned key set, filled from the stored columns. */
  function rebuilt(): Record<string, unknown> {
    return {
      agentType: row.agent_type, createdAt: row.created_at, data: JSON.parse(row.data), engagementId: row.engagement_id,
      hostname: row.hostname, id: row.id, monotonicNs: row.monotonic_ns, ntpOffsetMs: row.ntp_offset_ms,
      operatorId: row.operator_id, prevHash: row.prev_hash, sessionId: row.session_id, sourceIP: row.source_ip,
      targetId: row.target_id, tier: 'chained', timestamp: row.timestamp
    }
  }

  it('the writer: the event it returns carries exactly the hashed keys plus those set after hashing', () => {
    expect(Object.keys(returned).filter((k) => !SET_AFTER_HASH.includes(k)).sort()).toEqual(HASHED_KEYS)
  })

  it('the writer: the stored hash and signature cover exactly the pinned keys, rebuilt from the columns', () => {
    const canonical = events.canonicalStringify(rebuilt())
    expect(crypto.createHash('sha256').update(canonical).digest('hex')).toBe(row.hash)
    expect(row.signature, 'the operator has a key, so the row is signed').toBeTruthy()
    const key = crypto.createPublicKey({ key: { crv: 'Ed25519', kty: 'OKP', x: Buffer.from(pubKey, 'base64').toString('base64url') }, format: 'jwk' })
    expect(crypto.verify(null, Buffer.from(canonical, 'utf8'), key, Buffer.from(row.signature!, 'base64'))).toBe(true)
  })

  it('the writer: columns outside the key set (envelope, subtype, signature) are stored but not hashed', () => {
    // The envelope columns are filled here, so the claim is not vacuous.
    expect(row.source).toBe('api')
    expect(row.mapper).toBe(JSON.stringify({ id: 'identity', version: '1' }))
    expect(row.subtype).toBe('command_start')
    const unhashed = Object.keys(row).filter((c) => !['agent_type', 'created_at', 'data', 'engagement_id', 'hostname', 'id',
      'monotonic_ns', 'ntp_offset_ms', 'operator_id', 'prev_hash', 'session_id', 'source_ip', 'target_id', 'timestamp', 'hash'].includes(c)).sort()
    expect(unhashed).toEqual(['mapper', 'raw_ref', 'schema_version', 'signature', 'source', 'subtype', 'transcript_uuid', 'ts_source'])
  })

  it('the app verifier: chainedRowCanonical builds the same key set, ignores extra columns, and matches the writer byte for byte', () => {
    const canonical = rules.chainedRowCanonical(row as unknown as Parameters<typeof rules.chainedRowCanonical>[0], JSON.parse(row.data))
    expect(Object.keys(JSON.parse(canonical)).sort()).toEqual(HASHED_KEYS)
    expect(canonical).toBe(events.canonicalStringify(rebuilt()))
  })

  it('the app verifier: the full walk accepts the rows the writer produced', async () => {
    const r = await anchor.verifyChainFullAsync()
    expect({ ok: r.ok, walked: r.walked, brokenAtEventId: r.brokenAtEventId, authentication: r.authentication })
      .toEqual({ ok: true, walked: 2, brokenAtEventId: null, authentication: 'verified' })
  })

  python.it('the recipient verifier: _rebuild_shapes builds the same key set and the same bytes', () => {
    const script = [
      'import importlib.util, json, sys',
      'spec = importlib.util.spec_from_file_location("redlog_verify", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'row = json.loads(sys.stdin.read())',
      'shapes, canon = m._rebuild_shapes(row)',
      'print(json.dumps({"shapes": shapes, "canonical": canon["canonical"], "keys": sorted(json.loads(canon["canonical"]).keys())}))'
    ].join('\n')
    const r = spawnSync(pythonBin, ['-I', '-c', script, VERIFIER], { input: JSON.stringify(row), encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    const out = JSON.parse(r.stdout) as { shapes: Array<[string, string]>; canonical: string; keys: string[] }
    expect(out.keys).toEqual(HASHED_KEYS)
    expect(out.canonical).toBe(events.canonicalStringify(rebuilt()))
    expect(out.shapes).toEqual([['canonical', row.hash]])
  })
})

// FR-062 relies on every commit reaching the disk before the API answers
// (spec.md "SQLite 維持 WAL 且每次 commit 同步落盤"). Nothing in db/index.ts sets
// `synchronous`; it is whatever the connection starts with.
sqlite.describe('PRAGMA synchronous on the project database', () => {
  let dir = ''
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-sync-')) })
  afterAll(() => { dbMod.closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

  // FINDING (Spec 071 T005): it is NORMAL, not FULL, on every project
  // connection once it has written anything. better-sqlite3 compiles SQLite
  // with SQLITE_DEFAULT_WAL_SYNCHRONOUS=1 (node_modules/better-sqlite3/deps/
  // defines.gypi), and SQLite applies that default when the connection first
  // opens the WAL — on its first write, which for a new project is the schema
  // transaction inside initDB itself. db/index.ts:140 sets journal_mode = WAL
  // and never sets `synchronous`. Under NORMAL a commit already acknowledged to
  // a producer can be lost on power failure or an OS crash (not on an app
  // crash). Flip both to `it` when db/index.ts sets `synchronous = FULL`.
  it.fails('is FULL on a new project once it has been written to', () => {
    dbMod.initDB(dir)
    dbMod.getDB().prepare('SELECT COUNT(*) FROM events').get()
    expect(dbMod.getDB().pragma('synchronous', { simple: true })).toBe(2)
  })

  it.fails('is FULL on a reopened project', () => {
    dbMod.closeDB()
    dbMod.initDB(dir)
    expect(dbMod.getDB().pragma('synchronous', { simple: true })).toBe(2)
  })
})
