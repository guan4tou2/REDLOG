// Helpers for test/fixtures/golden-pre071/ — a project database and two
// evidence bundles written by the code on main before Spec 071 (T002) — and
// for the generators that still run (provenance-vectors-generate.ts,
// test/extensions/basic-paths-fixture.ts).
//
// Spec 071 changes what NEW rows carry (`data._ingest`) and promises that rows
// already on disk are never touched and still verify the same way (FR-021,
// SC-001). That promise can only be tested against rows the old code wrote, so
// those rows are committed, together with what the old verifiers said about
// them. test/golden-old-rows.test.ts holds every later phase to them.
//
// How the fixture was made. The function that wrote it, generateGoldenPre071,
// was added in ec20dd90 ("test(071): pin today's ingestion behaviour before
// changing it (Phase 1)") and run there, on main before Phase 3, from a test
// with the clock module mocked by clockMock below and modules reset. It is
// deleted here, not kept: from Phase 3 (T021) on, the code it drives stamps
// every new row and refuses an unbound write, so it could no longer reproduce
// the fixture — and code nothing runs rots unseen. To see or re-run it, check
// out that commit: `git show ec20dd90:test/fixtures/golden-pre071-generate.ts`.
// The fixture is frozen; a change in what new rows carry is pinned in
// test/fixtures/provenance-vectors, not here.
//
// The generator was deterministic: the wall clock was faked, the monotonic
// clock followed it, ids counted up, the host name was fixed, and the
// operator's Ed25519 key was derived at run time from a fixed, public seed
// (writeOperatorKeys) and written to a temporary keys directory. Nothing secret is generated or committed: the seed is a sentence
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
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import zlib from 'node:zlib'

export const ENG = 'eng-golden-pre071'
export const OP = 'op-golden'
export const T_START = Date.UTC(2026, 10, 1, 10, 0, 0)
const KEY_SEED_TEXT = 'RedLog golden-pre071 fixture operator. A public test seed, not a secret.'

/** The two committed bundles: bundle-<name>.json.gz. */
export const BUNDLES = ['complete', 'projection'] as const

// The bundles are committed packed, as gzipped JSON ({ path: base64 }), not as
// loose files. Their manifest.json, manifest.hmac and operators.json carry
// fields named like credentials with high-entropy values — the operator token
// hash prefix, an HMAC keyed by that hash, the signer public key — and the
// repository's secret scanner reads text files, not archives. None of it is
// secret (the token was a fixed string in the generator, the key is public), but a scanner
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
