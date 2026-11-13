// Generator for test/fixtures/golden-pre071/ — a project database and two
// evidence bundles written by the code on main before Spec 071 (T002).
//
// Spec 071 changes what NEW rows carry (`data._ingest`) and promises that rows
// already on disk are never touched and still verify the same way (FR-021,
// SC-001). That promise can only be tested against rows the old code wrote, so
// those rows are committed, together with what the old verifiers said about
// them. test/golden-old-rows.test.ts holds every later phase to them.
//
// The fixture was written by this generator on main before Spec 071 Phase 3
// and is frozen: Phase 3 (T021) changed what new rows carry, so running the
// generator now produces rows with `data._ingest` — the change, not a reason
// to rewrite the fixture. The regeneration check was retired then; the
// generator stays as the record of how the fixture was made, and its helpers
// serve test/fixtures/provenance-vectors-generate.ts.
//
// Deterministic: the wall clock is faked, the monotonic clock follows it, ids
// count up, the host name is fixed, and the operator's Ed25519 key is derived
// at run time from a fixed, public seed and written to a temporary keys
// directory. Nothing secret is generated or committed: the seed is a sentence
// in this file, and only the public half of the key reaches the fixture.
//
// What the rows cover, as Spec 071 T002 asks:
//   api        ingest() with the `api` envelope, as POST /api/events calls it
//              (the route's own answers: test/api-events-legacy-mapping)
//   spool      files in a hook spool, replayed by main's drain
//              (test/helpers/spool-drain-as-main.ts)
//   in-process ingestEvent() without an envelope, and insertEvent() direct
//   logged     scanner http_* and dns rows, which land in events_logged
//   _raw       an envelope carrying the producer's raw bytes
//   _clock_anomaly          an NTP offset over the 30 s threshold
//   _source_time_rejected   a seconds-precision source_timestamp
//   sanitized  a field masked by sanitize(), with its system.sanitized row
//   projection a bundle exported after the sanitize, with scope masking and a
//              personal domain, so rows are transformed and omitted; the
//              other bundle is the whole chain before the sanitize

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import zlib from 'node:zlib'
import { vi } from 'vitest'

export const ENG = 'eng-golden-pre071'
export const OP = 'op-golden'
export const T_START = Date.UTC(2026, 10, 1, 10, 0, 0)
const HOST = 'golden-pre071-host'
const KEY_SEED_TEXT = 'RedLog golden-pre071 fixture operator. A public test seed, not a secret.'

/** What the generator writes inside its output directory, and nothing else. */
export const OUTPUTS = ['project', 'bundle-complete.json.gz', 'bundle-projection.json.gz', 'expected.json'] as const
export const BUNDLES = ['complete', 'projection'] as const

// The bundles are committed packed, as gzipped JSON ({ path: base64 }), not as
// loose files. Their manifest.json, manifest.hmac and operators.json carry
// fields named like credentials with high-entropy values — the operator token
// hash prefix, an HMAC keyed by that hash, the signer public key — and the
// repository's secret scanner reads text files, not archives. None of it is
// secret (the token is a fixed string below, the key is public), but a scanner
// cannot know that. The test unpacks them into a temporary directory.
export function packDir(dir: string): Buffer {
  const files: Record<string, string> = {}
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(r)
      else files[r] = fs.readFileSync(path.join(dir, r)).toString('base64')
    }
  }
  walk('')
  const sorted = Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]]))
  return zlib.gzipSync(Buffer.from(JSON.stringify(sorted, null, 1) + '\n'), { level: 9 })
}
export function unpackTo(archive: string, dir: string): string {
  const files = JSON.parse(zlib.gunzipSync(fs.readFileSync(archive)).toString('utf8')) as Record<string, string>
  for (const [rel, b64] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), Buffer.from(b64, 'base64'))
  }
  return dir
}

/** Tables whose rows the fixture pins, with a stable order. */
export const PINNED_TABLES: ReadonlyArray<{ table: string; order: string }> = [
  { table: 'events', order: 'rowid' },
  { table: 'events_logged', order: 'rowid' },
  { table: 'sanitized_events', order: 'rowid' },
  { table: 'operators', order: 'id' }
]

/** Every column of every pinned row, in a fixed order, as stored. */
export function dumpRows(db: { prepare: (sql: string) => { all: () => unknown[] } }): Record<string, Array<Record<string, unknown>>> {
  const out: Record<string, Array<Record<string, unknown>>> = {}
  for (const { table, order } of PINNED_TABLES) {
    out[table] = db.prepare(`SELECT rowid AS _rowid, * FROM ${table} ORDER BY ${order}`).all() as Array<Record<string, unknown>>
  }
  return out
}

export const sha256 = (b: string | Buffer): string => crypto.createHash('sha256').update(b).digest('hex')

/** Faking the clock module: the monotonic counter follows the faked wall clock
 *  (so the verifier's monotonic check sees consistent deltas), and the NTP
 *  offset is whatever `clockControl.ntpOffsetMs` says. */
export const clockControl: { ntpOffsetMs: number | null } = { ntpOffsetMs: null }
export function clockMock(real: Record<string, unknown>): Record<string, unknown> {
  return {
    ...real,
    monotonicNs: () => String(BigInt(Date.now() - T_START) * 1_000_000n + 5_000_000_000n),
    getNtpOffsetMs: () => clockControl.ntpOffsetMs
  }
}

/** The operator's key pair, from the public seed above. */
export function writeOperatorKeys(keysDir: string, operatorId: string): void {
  const seed = crypto.createHash('sha256').update(KEY_SEED_TEXT).digest()
  // PKCS#8 wrapper for a raw Ed25519 seed (RFC 8410).
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed])
  const jwk = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }).export({ format: 'jwk' }) as { d: string; x: string }
  fs.mkdirSync(keysDir, { recursive: true })
  fs.writeFileSync(path.join(keysDir, `${operatorId}.key`), Buffer.from(jwk.d, 'base64url').toString('base64'), { mode: 0o600 })
  fs.writeFileSync(path.join(keysDir, `${operatorId}.pub`), Buffer.from(jwk.x, 'base64url').toString('base64'))
}

function copyTree(from: string, to: string, skip: (rel: string) => boolean = () => false, rel = ''): void {
  for (const e of fs.readdirSync(path.join(from, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (skip(r)) continue
    if (e.isDirectory()) copyTree(from, to, skip, r)
    else {
      fs.mkdirSync(path.join(to, rel), { recursive: true })
      fs.copyFileSync(path.join(from, r), path.join(to, r))
    }
  }
}

export const VERIFIER = path.resolve(__dirname, '..', '..', 'tools', 'redlog-verify.py')
export const pythonBin = ['python3', 'python'].find((b) => spawnSync(b, ['--version']).status === 0) ?? 'python3'

/** tools/redlog-verify.py on a bundle, with the bundle's own path taken out of
 *  what it prints so the output can be compared across checkouts. */
export function runPythonVerifier(bundleDir: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(pythonBin, ['-I', VERIFIER, bundleDir], { encoding: 'utf8' })
  const real = fs.realpathSync(bundleDir)
  // The "Bundle dir" line is replaced whole: on Windows the verifier prints the
  // extended-length form (`\\?\C:\…`) of the path it was given.
  const scrub = (s: string): string => s.replace(/\r\n/g, '\n').replace(/^(Bundle dir\s*: ).*$/m, '$1<bundle>')
    .split(real).join('<bundle>').split(bundleDir).join('<bundle>')
  return { status: r.status, stdout: scrub(r.stdout ?? ''), stderr: scrub(r.stderr ?? '') }
}

export interface GoldenExpected {
  generatedFrom: string
  rows: Record<string, Array<{ id: string; hash: string | null; sha256: string }>>
  rowsSha256: string
  appVerify: Record<string, unknown>
  bundleVerify: Record<string, unknown>
  pythonVerify: Record<string, { status: number | null; stdout: string; stderr: string }>
}

export function digestRows(rows: Record<string, Array<Record<string, unknown>>>): Pick<GoldenExpected, 'rows' | 'rowsSha256'> {
  const out: GoldenExpected['rows'] = {}
  for (const [table, list] of Object.entries(rows)) {
    out[table] = list.map((r) => ({ id: String(r.id), hash: (r.hash as string | null | undefined) ?? null, sha256: sha256(JSON.stringify(r)) }))
  }
  return { rows: out, rowsSha256: sha256(JSON.stringify(rows)) }
}

/** The parts of a full-walk result that describe the stored chain. */
export function appVerifyView(r: Record<string, unknown>): Record<string, unknown> {
  const pick = ['ok', 'walked', 'brokenAtEventId', 'brokenReason', 'currentHead', 'anchorMatchesWalkedHead', 'clockAnomalies',
    'signedCount', 'unsignedCount', 'noPubKeyCount', 'authentication', 'authenticationReasons', 'firstUncheckedEventId', 'badSignatureAtEventId']
  return Object.fromEntries(pick.map((k) => [k, r[k] ?? null]))
}

/**
 * Write the fixture into `out`: project/ (the database and the files its rows
 * refer to), bundle-complete.json.gz, bundle-projection.json.gz (packed; see
 * packDir) and expected.json. Only those four are replaced; anything else in
 * `out` is left alone.
 *
 * Call with `vi.doMock(<clock module>, clockMock)` in place and modules reset;
 * the other fakes are installed and removed here.
 */
export async function generateGoldenPre071(out: string): Promise<GoldenExpected> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-golden-pre071-'))
  const projectDir = path.join(work, 'project')
  const spoolDir = path.join(work, 'spool')
  const keysDir = path.join(work, 'keys')
  const exportsDir = path.join(work, 'exports')
  const prevKeys = process.env.REDLOG_KEYS_DIR
  process.env.REDLOG_KEYS_DIR = keysDir
  let id = 0
  vi.spyOn(crypto, 'randomUUID').mockImplementation(() => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`)
  vi.spyOn(os, 'hostname').mockReturnValue(HOST)
  vi.useFakeTimers({ now: T_START, toFake: ['Date'] })
  clockControl.ntpOffsetMs = null
  try {
    // Loaded after the fakes: BOOT_EPOCH_MS and the first session id are taken at module load.
    const db = await import('../../src/core/db/index')
    const events = await import('../../src/core/db/events')
    const ops = await import('../../src/core/db/operators')
    const ingestMod = await import('../../src/core/ingest')
    const redaction = await import('../../src/core/redaction')
    const { sanitize } = await import('../../src/core/sanitize')
    const { exportBundle } = await import('../../src/core/bundle-export')
    const { verifyBundleDir } = await import('../../src/core/bundle-verify')
    const { verifyChainFullAsync } = await import('../../src/core/chain-anchor')
    const { closeHttpBodyIndex } = await import('../../src/core/http-body-index')
    const { drainSpoolAsMain } = await import('../helpers/spool-drain-as-main')

    const step = (): void => { vi.advanceTimersByTime(1000) }
    db.initDB(projectDir)
    db.bindDBEngagement(ENG)
    ingestMod._resetIngest()
    redaction.configureRedaction({ denylist: ['pre071-redact-me'] })
    writeOperatorKeys(keysDir, OP)
    // A fixed operator token (its hash keys the bundle's manifest.hmac), assembled at run time.
    ops.createOperator({ id: OP, name: 'Golden Operator', token: ['golden', 'pre071', 'operator'].join('-'), isPrimary: true })
    const who = { engagementId: ENG, operatorId: OP }
    const API = { source: 'api', mapper: { id: 'identity', version: '1' } }
    const api = (agentType: string, data: Record<string, unknown>, targetId?: string, extra: Record<string, unknown> = {}): string => {
      step()
      const r = ingestMod.ingest({ agentType, data, ...who, ...(targetId ? { targetId } : {}), envelope: { ...API, ...extra } })
      if (!r.event) throw new Error(`golden: ${agentType}.${String(data.subtype)} was not written (${r.skipped})`)
      return r.event.id
    }
    const body = (text: string): Record<string, unknown> => {
      const b = Buffer.from(text)
      return { data: b.toString('base64'), encoding: 'base64', size: b.length, sha256: sha256(b) }
    }

    // In-process, direct: what main writes on every project open.
    step()
    events.insertEvent('system', { subtype: 'session_start' }, who)

    // api: commands, in scope, out of scope and personal.
    api('shell', { subtype: 'command_start', command: 'nmap -sV 10.0.0.5', terminalId: 't-api', pid: 2001, command_id: 'c-1', source_timestamp: Date.now() })
    api('shell', { subtype: 'command_end', command: 'nmap -sV 10.0.0.5', terminalId: 't-api', pid: 2001, command_id: 'c-1', exit_code: 0,
      stdout: '22/tcp open ssh\n80/tcp open http\n', output_started_at: Date.now() - 500, source_timestamp: Date.now() })
    api('shell', { subtype: 'command_start', command: 'curl -s http://203.0.113.7/', terminalId: 't-api', pid: 2002, command_id: 'c-2' }, '203.0.113.7')
    api('shell', { subtype: 'command_end', command: 'curl -s http://203.0.113.7/', terminalId: 't-api', pid: 2002, command_id: 'c-2', exit_code: 0,
      stdout: '<html>out of scope body</html>\n' }, '203.0.113.7')
    api('shell', { subtype: 'command_start', command: 'ping -c1 127.0.0.1', terminalId: 't-api', pid: 2003, command_id: 'c-3' }, '127.0.0.1')
    api('marker', { subtype: 'finding', title: 'Golden finding', notes: 'SSH open on the in-scope host' }, '10.0.0.5')

    // logged tier, with a saved body.
    api('scanner', { subtype: 'http_request_start', flow_id: 'f-1', method: 'GET', url: 'http://10.0.0.5/', request_body: body('') })
    api('scanner', { subtype: 'http_response', flow_id: 'f-1', status_code: 200, url: 'http://10.0.0.5/', response_body: body('<p>golden page</p>') })
    api('dns', { subtype: 'dns_query', qname: 'golden.test', qtype: 'A', flow_id: 'd-1' })

    // _raw: the producer's bytes kept beside the row.
    const rawBody = { agent_type: 'shell', data: { subtype: 'command_start', command: 'id', terminalId: 't-raw', pid: 2004 } }
    api('shell', { ...rawBody.data }, undefined, { raw: JSON.stringify(rawBody) })

    // _source_time_rejected: seconds where milliseconds were meant.
    api('shell', { subtype: 'command_start', command: 'uname -a', terminalId: 't-api', pid: 2005, source_timestamp: 1_762_000_000 })

    // in-process, no envelope; one with the clock anomaly.
    step()
    ingestMod.ingestEvent('shell', { subtype: 'command_start', command: 'whoami', terminalId: 'term-1', pid: 2006, source: 'builtin-terminal' }, who)
    step()
    ingestMod.ingestEvent('agent', { subtype: 'tool_call', agent: 'claude-code', tool_name: 'Bash', tool_use_id: 'u-1', session_id: 's-1', input: { command: 'id' } }, who)
    step()
    clockControl.ntpOffsetMs = 45_000
    ingestMod.ingestEvent('shell', { subtype: 'command_start', command: 'date', terminalId: 'term-1', pid: 2007, source: 'builtin-terminal' }, who)
    clockControl.ntpOffsetMs = null

    // A denylisted word in output: redaction spans now, sanitized below.
    const leaky = api('shell', { subtype: 'command_end', command: 'cat notes.txt', terminalId: 't-api', pid: 2008, command_id: 'c-8', exit_code: 0,
      stdout: 'note=pre071-redact-me-please\n' })

    // spool: what a hook wrote while the API was unreachable, replayed by main's drain.
    fs.mkdirSync(spoolDir)
    const spoolFile = (name: string, payload: Record<string, unknown>): void =>
      fs.writeFileSync(path.join(spoolDir, name), JSON.stringify({ ...payload, _identity: { engagementId: ENG, operatorId: OP } }))
    const offlineAt = Date.now() - 30_000
    spoolFile('0001.json', { agent_type: 'shell', data: { subtype: 'command_start', command: 'ls /tmp', shell: 'bash', pid: 3001, terminalId: 't-spool', source_timestamp: offlineAt } })
    spoolFile('0002.json', { agent_type: 'shell', data: { subtype: 'command_end', command: 'ls /tmp', shell: 'bash', pid: 3001, terminalId: 't-spool', exit_code: 0,
      stdout: 'a\nb\n', output_started_at: offlineAt + 10, source_timestamp: offlineAt + 50 } })
    spoolFile('0003.json', { agent_type: 'scanner', data: { subtype: 'capture_gap', source: 'mitmproxy', reason: 'queue-full', capture_delivery: 'not-queued',
      gap_started_at: offlineAt, gap_ended_at: offlineAt + 900, skipped_units: 3, skipped_body_bytes: 120, reported_at: offlineAt + 1000 } })
    step()
    const drained = drainSpoolAsMain(spoolDir, who)
    if (!drained || drained.replayed !== 3) throw new Error(`golden: spool replay ${JSON.stringify(drained)}`)

    // Bundles. Each export appends its own chained rows (the logged-tier digest
    // and the seal), which are old rows too by the time anyone reads them.
    // The whole chain first: a sanitized replacement makes any later bundle a
    // projection, so the sanitize step sits between the two exports.
    step()
    const complete = exportBundle(ENG, { outRoot: path.join(exportsDir, 'complete') })

    // sanitized: the denylisted word masked after the fact.
    step()
    const s = sanitize({ eventIds: [leaky], fields: ['stdout'], ...who, reason: 'golden fixture' })
    if (s.applied !== 1) throw new Error(`golden: sanitize applied ${s.applied}`)

    step()
    const projection = exportBundle(ENG, { outRoot: path.join(exportsDir, 'projection'),
      scope: { targets: ['10.0.0.0/24'], personalDomains: ['127.0.0.0/8'] } })

    const appVerify = appVerifyView(await verifyChainFullAsync() as unknown as Record<string, unknown>)
    const rows = dumpRows(db.getDB())
    closeHttpBodyIndex()
    // closeDB does not checkpoint: the writer closes while the cached reader
    // is still open, so the rows would stay in timeline.db-wal.
    db.getDB().pragma('wal_checkpoint(TRUNCATE)')
    db.closeDB()

    // The fixture: the database and the files its rows refer to; the derived
    // body index is rebuilt on open.
    fs.mkdirSync(out, { recursive: true })
    for (const o of OUTPUTS) fs.rmSync(path.join(out, o), { recursive: true, force: true })
    copyTree(projectDir, path.join(out, 'project'), (rel) => /^timeline\.db-(wal|shm)$|^http-body-index\.db/.test(rel))
    const exported = { complete: complete.outDir, projection: projection.outDir }
    for (const name of BUNDLES) fs.writeFileSync(path.join(out, `bundle-${name}.json.gz`), packDir(exported[name]))
    // What the verifiers say is taken from the packed bytes, unpacked, as the
    // test will see them.
    const seen = Object.fromEntries(BUNDLES.map((name) =>
      [name, unpackTo(path.join(out, `bundle-${name}.json.gz`), path.join(work, 'unpacked', `bundle-${name}`))])) as Record<typeof BUNDLES[number], string>
    const expected: GoldenExpected = {
      generatedFrom: 'test/fixtures/golden-pre071-generate.ts on main before Spec 071',
      ...digestRows(rows),
      appVerify,
      bundleVerify: { complete: verifyBundleDir(seen.complete), projection: verifyBundleDir(seen.projection) },
      pythonVerify: { complete: runPythonVerifier(seen.complete), projection: runPythonVerifier(seen.projection) }
    }
    fs.writeFileSync(path.join(out, 'expected.json'), JSON.stringify(expected, null, 2) + '\n')
    return expected
  } finally {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (prevKeys === undefined) delete process.env.REDLOG_KEYS_DIR
    else process.env.REDLOG_KEYS_DIR = prevKeys
    fs.rmSync(work, { recursive: true, force: true })
  }
}
