// One set of rules, two verifiers (docs/audit-trail.md "Verifying a bundle").
//
// Small bundles are produced by the real exporter at run time, then tampered
// with the way a holder of the bundle could. Each one goes through the
// standalone tools/redlog-verify.py a recipient runs and through the app's own
// verifyBundleDir, and both must reach the same verdict — the one in the
// table. The rows the project database itself can be put in (signed, unsigned,
// mixed, wrong key) also go through the Integrity walk, which must agree.
//
// Keys are generated at run time into a temporary directory; nothing here is a
// real credential.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { initDB, closeDB, getDB } from '../src/core/db/index'
import * as events from '../src/core/db/events'
import * as ops from '../src/core/db/operators'
import { exportBundle } from '../src/core/bundle-export'
import { verifyBundleDir } from '../src/core/bundle-verify'
import { verifyChainFullAsync } from '../src/core/chain-anchor'
import { BODY_REF_KEYS, VERIFY_EXIT, chainedRowCanonical, type VerifyCategory } from '../src/core/evidence-rules'
import { BODY_REF_FIELDS } from '../src/core/content-contract'
import { BODY_REF_FOR } from '../src/core/redact-export'

const VERIFIER = path.resolve(__dirname, '..', 'tools', 'redlog-verify.py')
const python = ['python3', 'python'].find((bin) => spawnSync(bin, ['--version']).status === 0) ?? null
const hasCryptography = python
  ? spawnSync(python, ['-I', '-c', 'import cryptography.hazmat.primitives.asymmetric.ed25519']).status === 0
  : false
const CATEGORY_BY_EXIT = Object.fromEntries(Object.entries(VERIFY_EXIT).map(([k, v]) => [v, k])) as Record<number, VerifyCategory>
const sha = (b: Buffer | string): string => crypto.createHash('sha256').update(b).digest('hex')

let root = ''
const keysEnv = process.env.REDLOG_KEYS_DIR

// ── Bundle surgery a holder of the bundle could do ──────────────────────────
function readManifest(dir: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
}
function writeManifest(dir: string, m: Record<string, unknown>): void {
  const p = path.join(dir, 'manifest.json')
  fs.writeFileSync(p, JSON.stringify(m, null, 2))
  fs.writeFileSync(path.join(dir, 'manifest.sha256'), sha(fs.readFileSync(p)) + '\n')
}
/** Recompute a file's manifest entry, as anyone holding the bundle can. */
function relist(dir: string, ...rels: string[]): void {
  const m = readManifest(dir)
  for (const rel of rels) {
    const bytes = fs.readFileSync(path.join(dir, rel))
    const entry = m.files.find((f: { path: string }) => f.path === rel)
    if (entry) { entry.sha256 = sha(bytes); entry.bytes = bytes.length } else m.files.push({ path: rel, bytes: bytes.length, sha256: sha(bytes) })
  }
  writeManifest(dir, m)
}
function unlist(dir: string, rel: string): void {
  const m = readManifest(dir)
  m.files = m.files.filter((f: { path: string }) => f.path !== rel)
  writeManifest(dir, m)
}
function rows(dir: string, file = 'events.jsonl'): Array<Record<string, any>> {
  return fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
function writeRows(dir: string, list: Array<Record<string, unknown>>, file = 'events.jsonl'): void {
  fs.writeFileSync(path.join(dir, file), list.map((r) => JSON.stringify(r)).join('\n') + (list.length ? '\n' : ''))
}
/** Re-hash an unsigned row after editing it; a signed one cannot be redone. */
function rehash(row: Record<string, any>): void {
  row.hash = sha(chainedRowCanonical(row as Parameters<typeof chainedRowCanonical>[0], JSON.parse(row.data)))
}
/** The same bundle in the v3 format: what a release before seals wrote. */
function asV3(dir: string): void {
  const list = rows(dir).slice(0, -1)
  writeRows(dir, list)
  const m = readManifest(dir)
  delete m.seal; delete m.omittedAttachments
  m.bundleVersion = 3
  m.tiers.chained = list.length
  writeManifest(dir, m)
  relist(dir, 'events.jsonl')
}
function copy(src: string, name: string): string {
  const dst = path.join(root, 'vectors', name)
  fs.cpSync(src, dst, { recursive: true })
  return dst
}
function rawPubKey(): string {
  return crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
}

// ── Projects ────────────────────────────────────────────────────────────────
interface Project { dir: string; bundle: string }
function project(name: string, opts: { signed: boolean; unsignedRow?: boolean; exclude?: string[] }): Project {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  initDB(dir)
  const op = opts.signed ? 'vec-op' : 'plain-op'
  if (opts.signed) ops.createOperator({ id: op, name: op, token: ops.generateToken(), isPrimary: true })
  const ins = (type: string, data: Record<string, unknown>, operatorId = op) => events.insertEvent(type, data, { operatorId })!
  const put = (rel: string, bytes: Buffer): string => {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, bytes)
    return p
  }
  ins('shell', { subtype: 'command_start', command: 'id' })
  const jpg = crypto.randomBytes(48)
  ins('screenshot', { trigger: 'manual', filePath: put('screenshots/shot.jpg', jpg), filename: 'shot.jpg', size: jpg.length, sha256: sha(jpg) })
  // A recording split in two parts: each part is bound to its own digest.
  const part1 = Buffer.from('{"version":2}\n[0.1,"o","one"]\n'), part2 = Buffer.from('{"version":2}\n[0.2,"o","two"]\n')
  const c1 = put('casts/rec.cast', part1), c2 = put('casts/rec.part000002.cast', part2)
  ins('shell', { subtype: 'session_end', source: 'builtin-terminal', terminalId: 't', recordingId: 'rec', castPath: c1,
    castSha256: sha(Buffer.concat([part1, part2])), castBytes: part1.length + part2.length,
    castSegments: [{ path: c1, bytes: part1.length, sha256: sha(part1) }, { path: c2, bytes: part2.length, sha256: sha(part2) }] })
  const out = Buffer.from('command output kept in the body store')
  put(`http-bodies/${sha(out)}.body`, out)
  ins('shell', { subtype: 'command_end', command: 'id', output_ref: { sha256: sha(out), file: `${sha(out)}.body`, size: out.length } })
  const resp = Buffer.from('HTTP/1.1 200 body')
  put(`http-bodies/${sha(resp)}.body`, resp)
  ins('scanner', { subtype: 'http_response', flow_id: 'f', response_body_ref: { sha256: sha(resp), file: `${sha(resp)}.body`, size: resp.length } })
  const art = Buffer.from('artifact bytes')
  put('artifacts/loot.txt', art)
  ins('file_transfer', { subtype: 'artifact_added', stored: 'artifacts/loot.txt', sha256: sha(art), size: art.length })
  // A transcript keeps growing after its snapshot: the snapshot binds a prefix.
  const first = Buffer.from('{"turn":1}\n')
  const sidecar = put('agent-transcripts/claude-11111111-2222-3333-4444-555555555555.jsonl', first)
  ins('agent', { subtype: 'transcript_snapshot', session_id: 's', agent: 'claude', snapshot_path: sidecar, cumulative_bytes: first.length, cumulative_sha256: sha(first) })
  fs.appendFileSync(sidecar, '{"turn":2}\n')
  ins('dns', { subtype: 'dns_query', query_name: 'example.test' })
  if (opts.unsignedRow) ins('shell', { subtype: 'command_start', command: 'no key for this operator' }, 'vec-nokey')
  ins('shell', { subtype: 'command_end', command: 'id', exit_code: 0 })
  const { outDir } = exportBundle('default', {
    outRoot: path.join(root, 'out', name),
    includeAgentTranscripts: !opts.exclude,
    excludeAttachments: opts.exclude ? new Set(opts.exclude) : undefined
  })
  return { dir, bundle: outDir }
}

// ── Both verifiers ──────────────────────────────────────────────────────────
function pythonVerdict(dir: string, flags: string[]): { category: VerifyCategory; out: string } {
  // Without `cryptography` a signed bundle cannot be checked and fails closed;
  // both sides then judge the chain alone.
  const r = spawnSync(python!, ['-I', VERIFIER, ...flags, ...(hasCryptography ? [] : ['--hash-only']), dir], { encoding: 'utf8' })
  return { category: CATEGORY_BY_EXIT[r.status ?? -1], out: r.stdout + r.stderr }
}
function judge(dir: string, opts: { requireSeal?: boolean } = {}) {
  const ts = verifyBundleDir(dir, { requireSeal: opts.requireSeal, hashOnly: python !== null && !hasCryptography })
  const py = python ? pythonVerdict(dir, opts.requireSeal ? ['--require-seal'] : []) : null
  return { ts, py }
}

let A: Project, B: Project, C: Project, D: Project
let walkA: Awaited<ReturnType<typeof verifyChainFullAsync>>
let walkB: typeof walkA, walkC: typeof walkA, walkWrongKey: typeof walkA

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-vectors-'))
  process.env.REDLOG_KEYS_DIR = path.join(root, 'keys')
  A = project('signed', { signed: true })
  walkA = await verifyChainFullAsync()
  // Same project, the operator's key swapped in the database: every
  // signature now checks against the wrong key.
  getDB().prepare('UPDATE operators SET signer_pub_key = ?').run(rawPubKey())
  walkWrongKey = await verifyChainFullAsync()
  closeDB()
  B = project('unsigned', { signed: false })
  walkB = await verifyChainFullAsync()
  closeDB()
  C = project('mixed', { signed: true, unsignedRow: true })
  walkC = await verifyChainFullAsync()
  closeDB()
  D = project('omitted', { signed: true, exclude: ['screenshots/shot.jpg'] })
  closeDB()
}, 60_000)
afterAll(() => {
  if (keysEnv === undefined) delete process.env.REDLOG_KEYS_DIR
  else process.env.REDLOG_KEYS_DIR = keysEnv
  fs.rmSync(root, { recursive: true, force: true })
})

type Vector = { name: string; expect: VerifyCategory; build: () => string; requireSeal?: boolean; check?: (ts: ReturnType<typeof verifyBundleDir>, py: string) => void }
const vectors: Vector[] = [
  { name: 'clean signed', expect: 'verified', build: () => A.bundle,
    check: (ts, py) => {
      expect(ts.seal).toBe('sealed')
      expect(ts.attachments.mismatched).toEqual([])
      expect(ts.attachments.bound.sort()).toEqual([
        `agent-transcripts/claude-11111111-2222-3333-4444-555555555555.jsonl`, 'artifacts/loot.txt',
        'casts/rec.cast', 'casts/rec.part000002.cast',
        ...readManifest(A.bundle).files.map((f: { path: string }) => f.path).filter((p: string) => p.startsWith('http-bodies/')).sort(),
        'screenshots/shot.jpg'].sort())
      expect(py).toMatch(/Seal\s+: SEALED/)
    } },
  { name: 'clean unsigned', expect: 'notAuthenticated', build: () => B.bundle,
    check: (ts) => expect(ts.seal).toBe('sealed') },
  { name: 'unsigned row inside a signed chain', expect: 'failed', build: () => C.bundle },
  { name: 'attachment replaced, manifest recomputed', expect: 'attachmentMismatch', build: () => {
    const d = copy(A.bundle, 'replaced-relisted')
    fs.writeFileSync(path.join(d, 'screenshots/shot.jpg'), crypto.randomBytes(48))
    relist(d, 'screenshots/shot.jpg')
    return d
  }, check: (ts, py) => { expect(ts.attachments.mismatched).toEqual(['screenshots/shot.jpg']); expect(py).toContain('SEAL MISMATCH') } },
  { name: 'attachment replaced, manifest untouched', expect: 'attachmentMismatch', build: () => {
    const d = copy(A.bundle, 'replaced')
    fs.writeFileSync(path.join(d, 'screenshots/shot.jpg'), crypto.randomBytes(48))
    return d
  } },
  ...(['casts/rec.part000002.cast', 'artifacts/loot.txt', 'agent-transcripts/claude-11111111-2222-3333-4444-555555555555.jsonl', 'http-bodies'] as const).map((rel): Vector => ({
    name: `attachment replaced, manifest recomputed: ${rel}`, expect: 'attachmentMismatch', build: () => {
      const d = copy(A.bundle, `replaced-${rel.replace(/\W/g, '_')}`)
      // Every body: the one a chained row names and the one a logged row names.
      const targets = rel === 'http-bodies' ? fs.readdirSync(path.join(d, rel)).map((n) => `${rel}/${n}`) : [rel]
      // The first byte, which is inside a transcript's bound prefix too.
      for (const t of targets) {
        const bytes = fs.readFileSync(path.join(d, t))
        bytes[0] ^= 1
        fs.writeFileSync(path.join(d, t), bytes)
      }
      relist(d, ...targets)
      return d
    }
  })),
  // Grown past its snapshot the transcript still matches the prefix its event
  // bound, so it is no attachment mismatch; it is not what the export sealed.
  { name: 'transcript appended to after export', expect: 'sealMismatch', build: () => {
    const d = copy(A.bundle, 'transcript-grown')
    const rel = 'agent-transcripts/claude-11111111-2222-3333-4444-555555555555.jsonl'
    fs.appendFileSync(path.join(d, rel), '{"turn":3}\n')
    relist(d, rel)
    return d
  }, check: (ts) => expect(ts.attachments.mismatched).toEqual([]) },
  { name: 'file added that no event references, listed', expect: 'sealMismatch', build: () => {
    const d = copy(A.bundle, 'added-listed')
    fs.writeFileSync(path.join(d, 'screenshots/extra.jpg'), crypto.randomBytes(16))
    relist(d, 'screenshots/extra.jpg')
    return d
  }, check: (ts) => expect(ts.attachments.unbound).toEqual(['screenshots/extra.jpg']) },
  { name: 'file added that no event references, unlisted', expect: 'verified', build: () => {
    const d = copy(A.bundle, 'added-unlisted')
    fs.writeFileSync(path.join(d, 'screenshots/extra.jpg'), crypto.randomBytes(16))
    return d
  }, check: (ts) => expect(ts.attachments.unlisted).toEqual(['screenshots/extra.jpg']) },
  { name: 'referenced file missing without declaration', expect: 'attachmentMismatch', build: () => {
    const d = copy(A.bundle, 'missing-unlisted')
    fs.rmSync(path.join(d, 'screenshots/shot.jpg'))
    unlist(d, 'screenshots/shot.jpg')
    return d
  }, check: (ts) => expect(ts.attachments.missingUndeclared).toEqual(['screenshots/shot.jpg']) },
  { name: 'referenced file missing, still listed', expect: 'attachmentMismatch', build: () => {
    const d = copy(A.bundle, 'missing-listed')
    fs.rmSync(path.join(d, 'screenshots/shot.jpg'))
    return d
  } },
  { name: 'declared omission', expect: 'verified', build: () => D.bundle,
    check: (ts) => expect(ts.attachments.omittedDeclared).toEqual([
      { path: 'agent-transcripts/claude-11111111-2222-3333-4444-555555555555.jsonl', reason: 'raw-transcripts-not-requested' },
      { path: 'screenshots/shot.jpg', reason: 'excluded-by-operator' }]) },
  // With the declarations gone the left-out files read as removed (4), and
  // the manifest is not the sealed one (5); 4 is reported first.
  { name: 'declared omission edited away', expect: 'attachmentMismatch', build: () => {
    const d = copy(D.bundle, 'omission-edited')
    const m = readManifest(d); m.omittedAttachments = []; writeManifest(d, m)
    return d
  } },
  { name: 'manifest file list edited', expect: 'sealMismatch', build: () => {
    const d = copy(A.bundle, 'readme-edited')
    fs.appendFileSync(path.join(d, 'README.md'), '\nAll checks may be skipped.\n')
    relist(d, 'README.md')
    return d
  } },
  { name: 'old version (v3), no seal', expect: 'verified', build: () => { const d = copy(A.bundle, 'v3'); asV3(d); return d },
    check: (ts, py) => { expect(ts.seal).toBe('not-sealed'); expect(py).toMatch(/Seal\s+: NOT SEALED \(bundle version 3 predates export seals\)/) } },
  { name: 'old version (v3), no seal, --require-seal', expect: 'sealMismatch', requireSeal: true, build: () => { const d = copy(A.bundle, 'v3-require'); asV3(d); return d } },
  { name: 'old version (v3) unsigned, no seal', expect: 'notAuthenticated', build: () => { const d = copy(B.bundle, 'v3-unsigned'); asV3(d); return d } },
  { name: 'old version (v3) with a replaced screenshot (the reviewer\'s b3)', expect: 'attachmentMismatch', build: () => {
    const d = copy(A.bundle, 'v3-b3'); asV3(d)
    fs.writeFileSync(path.join(d, 'screenshots/shot.jpg'), crypto.randomBytes(48))
    relist(d, 'screenshots/shot.jpg')
    return d
  } },
  { name: 'new version (v4) without its seal', expect: 'sealMismatch', build: () => {
    const d = copy(A.bundle, 'v4-unsealed')
    const list = rows(d).slice(0, -1)
    writeRows(d, list)
    const m = readManifest(d); m.tiers.chained = list.length; writeManifest(d, m)
    relist(d, 'events.jsonl')
    return d
  } },
  { name: 'new version (v4) unsigned, seal removed and manifest says so', expect: 'sealMismatch', build: () => {
    const d = copy(B.bundle, 'v4-unsealed-unsigned')
    const list = rows(d).slice(0, -1)
    writeRows(d, list)
    const m = readManifest(d); m.tiers.chained = list.length; m.seal = { exportId: null }; writeManifest(d, m)
    relist(d, 'events.jsonl')
    return d
  } },
  { name: 'seal present and mismatching (a sealed manifest count edited)', expect: 'sealMismatch', build: () => {
    const d = copy(B.bundle, 'seal-mismatch')
    const m = readManifest(d); m.sanitizedOutOfScope = 7; writeManifest(d, m)
    return d
  } },
  { name: 'tail truncated before the seal, manifest made consistent', expect: 'sealMismatch', build: () => {
    const d = copy(A.bundle, 'truncated-v4')
    const list = rows(d)
    list.splice(list.length - 2, 1)
    writeRows(d, list)
    const m = readManifest(d)
    const kept = list.slice(0, -1)
    const head = sha(kept.at(-1)!.hash + String(kept.length))
    m.chainHead = { hash: head, eventCount: kept.length }
    m.evidence.sourceChain = { hash: head, eventCount: kept.length }
    m.tiers.chained = list.length
    writeManifest(d, m)
    relist(d, 'events.jsonl')
    return d
  } },
  // Undetectable from inside the bundle: cut rows, drop the seal with them,
  // present it as a release that predates seals. The verdict says NOT SEALED;
  // only --require-seal, or an anchor held elsewhere, refuses it.
  { name: 'tail truncated with the seal, downgraded to v3', expect: 'verified', build: () => {
    const d = copy(A.bundle, 'truncated-downgraded'); asV3(d)
    const list = rows(d).slice(0, -1)
    writeRows(d, list)
    const m = readManifest(d)
    const head = sha(list.at(-1)!.hash + String(list.length))
    m.chainHead = { hash: head, eventCount: list.length }
    m.evidence.sourceChain = { hash: head, eventCount: list.length }
    m.tiers.chained = list.length
    writeManifest(d, m)
    relist(d, 'events.jsonl')
    return d
  }, check: (ts) => expect(ts.seal).toBe('not-sealed') },
  { name: 'wrong key', expect: 'failed', build: () => {
    const d = copy(A.bundle, 'wrong-key')
    const p = path.join(d, 'operators.json')
    fs.writeFileSync(p, JSON.stringify(JSON.parse(fs.readFileSync(p, 'utf8')).map((o: Record<string, unknown>) => ({ ...o, signerPubKey: rawPubKey() }))))
    relist(d, 'operators.json')
    return d
  } },
  { name: 'logged-tier row edited (digest mismatch), v4', expect: 'failed', build: () => {
    const d = copy(A.bundle, 'logged-edited')
    const list = rows(d, 'events_logged.jsonl')
    list[0].data = JSON.stringify({ ...JSON.parse(list[0].data), query_name: 'elsewhere.test' })
    writeRows(d, list, 'events_logged.jsonl')
    relist(d, 'events_logged.jsonl')
    return d
  } },
  { name: 'logged-tier row edited (digest mismatch), v3', expect: 'failed', build: () => {
    const d = copy(A.bundle, 'logged-edited-v3'); asV3(d)
    const list = rows(d, 'events_logged.jsonl')
    list[0].data = JSON.stringify({ ...JSON.parse(list[0].data), query_name: 'elsewhere.test' })
    writeRows(d, list, 'events_logged.jsonl')
    relist(d, 'events_logged.jsonl')
    return d
  } },
  // Fail closed on what a v4 verifier does not understand.
  { name: 'v4 manifest with a field this verifier does not know', expect: 'malformed', build: () => {
    const d = copy(A.bundle, 'unknown-field')
    const m = readManifest(d); m.attachmentPolicy = { trustManifest: true }; writeManifest(d, m)
    return d
  } },
  { name: 'newer bundle version', expect: 'malformed', build: () => {
    const d = copy(A.bundle, 'v5')
    const m = readManifest(d); m.bundleVersion = 5; writeManifest(d, m)
    return d
  } },
  { name: 'seal of an unknown seal version (unsigned, re-hashed)', expect: 'malformed', build: () => {
    const d = copy(B.bundle, 'seal-v2')
    const list = rows(d)
    const seal = list.at(-1)!
    seal.data = JSON.stringify({ ...JSON.parse(seal.data), sealVersion: 2 })
    rehash(seal)
    writeRows(d, list)
    relist(d, 'events.jsonl')
    return d
  } }
]

describe('golden evidence vectors: tools/redlog-verify.py and the app agree', () => {
  for (const v of vectors) {
    it(v.name, { timeout: 30_000 }, () => {
      const dir = v.build()
      const { ts, py } = judge(dir, { requireSeal: v.requireSeal })
      const want = python && !hasCryptography && v.expect === 'failed' && /unsigned row|wrong key/.test(v.name) ? ts.category : v.expect
      expect(ts.category, `${ts.problems.join('\n')}`).toBe(want)
      expect(ts.exitCode).toBe(VERIFY_EXIT[want])
      if (py) expect(py.category, py.out).toBe(ts.category)
      v.check?.(ts, py?.out ?? '')
    })
  }
})

describe('the Integrity walk over the project database agrees', () => {
  const category = (w: typeof walkA): VerifyCategory => !w.ok ? 'failed' : w.authentication === 'none' ? 'notAuthenticated' : 'verified'
  it('signed project: verified, as its bundle', () => {
    expect(category(walkA)).toBe('verified')
    expect(walkA.signedCount).toBe(walkA.walked)
  })
  it('unsigned project: consistent but not authenticated, as its bundle', () => {
    expect(category(walkB)).toBe('notAuthenticated')
    expect(walkB.ok).toBe(true)
  })
  it('an unsigned row in a signed chain fails, as its bundle does', () => {
    expect(category(walkC)).toBe('failed')
    expect(walkC.authentication).toBe('failed')
    expect(walkC.brokenAtEventId).toBeNull()
    expect(walkC.brokenReason).toMatch(/1 event\(s\) carry no signature although signing was in use/)
  })
  it('a signer key swapped in the database fails, as a swapped operators.json does', () => {
    expect(category(walkWrongKey)).toBe('failed')
    expect(walkWrongKey.brokenReason).toBe('signature invalid')
  })
})

describe('the rule tables stay one table', () => {
  it('body-reference keys cover every body pointer the app writes, in both verifiers', () => {
    expect([...BODY_REF_KEYS].sort()).toEqual([...new Set([...BODY_REF_FIELDS, ...Object.values(BODY_REF_FOR)])].sort())
    const py = fs.readFileSync(VERIFIER, 'utf8')
    for (const key of BODY_REF_KEYS) expect(py).toContain(`"${key}"`)
  })
})
