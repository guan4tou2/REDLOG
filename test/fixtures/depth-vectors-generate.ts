// Generator for test/fixtures/depth-vectors/ — rows whose `data` nested past
// the writer's bound (Spec 071 FR-097), exported as one sealed bundle, with
// what both verifiers say about it. A vector of its own, beside
// provenance-vectors: those rows do not move.
//
// Run through the test, never by hand:
//
//   REDLOG_WRITE_DEPTH_VECTORS=1 npx vitest run test/depth-vectors.test.ts
//
// Without the variable the test regenerates into a temporary directory and
// fails if the rows differ from what is committed. Deterministic the same way
// provenance-vectors-generate.ts is (faked wall clock, counted ids, fixed host
// name, a key from a public seed).
//
// The rows. "API" rows are written by ingest() with the entrance POST
// /api/events passes, as provenance-vectors-generate.ts writes them; the
// handler itself, which since 2026-11-14 accepts an over-deep body (owner:
// 「收下並摺疊」), is exercised in test/ingest-depth-doors.test.ts.
//   - an API row (chained) whose wrapped container holds keys and strings
//     outside the BMP, a lone surrogate, and numbers JavaScript and Python
//     write differently (0.00001, 1e21): inside the JSON text they are one
//     string, the same bytes for both verifiers;
//   - an API row (logged) shaped like the proxy's parsed JSON request body;
//   - a handoff spool file whose container at 64 holds several containers;
//   - an in-process row exactly at the limit, all arrays: the deepest shape a
//     row can now have, and the costliest for the Python verifier's recursion;
//   - an in-process row with a sender's marker-shaped object at 63 (kept)
//     and at 64 (wrapped).

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { vi } from 'vitest'
import { appVerifyView, clockControl, digestRows, dumpRows, packDir, runPythonVerifier, sha256, unpackTo, writeOperatorKeys, type GoldenExpected } from './golden-pre071-generate'

export const ENG = 'eng-depth-vectors'
export const OP = 'op-depth'
export const T_START = Date.UTC(2026, 10, 14, 10, 0, 0)
const HOST = 'depth-vectors-host'
export const BUNDLE = 'bundle.json.gz'
const OUTPUTS = [BUNDLE, 'expected.json'] as const

export interface DepthExpected {
  generatedFrom: string
  rows: GoldenExpected['rows']
  rowsSha256: string
  /** `_ingest.collapsed` of each row that has one, by subtype. */
  collapsed: Record<string, number>
  appVerify: Record<string, unknown>
  bundleVerify: Record<string, unknown>
  pythonVerify: { status: number | null; stdout: string; stderr: string }
  verifierSha256: string
}

export function clockMockDepth(real: Record<string, unknown>): Record<string, unknown> {
  return {
    ...real,
    monotonicNs: () => String(BigInt(Date.now() - T_START) * 1_000_000n + 5_000_000_000n),
    getNtpOffsetMs: () => clockControl.ntpOffsetMs
  }
}

/** `levels` nested arrays around `leaf`. */
export const nest = (levels: number, leaf: unknown): unknown => { let v = leaf; for (let i = 0; i < levels; i++) v = [v]; return v }

const LONE = String.fromCharCode(0xd800)
/** What sits below the bound in the API row: text both verifiers must agree on. */
export const AWKWARD = { [`clef \u{1D11E} ${LONE}`]: [`\u{1F600}${LONE}`, 0.00001, 1e21, -0, 1.5e-7, 123456789012345680000], plain: 'kept' }

export async function generateDepthVectors(out: string): Promise<DepthExpected> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-depth-vectors-'))
  const projectDir = path.join(work, 'project')
  const spoolDir = path.join(work, 'spool')
  const keysDir = path.join(work, 'keys')
  const prevKeys = process.env.REDLOG_KEYS_DIR
  process.env.REDLOG_KEYS_DIR = keysDir
  let id = 0
  vi.spyOn(crypto, 'randomUUID').mockImplementation(() => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`)
  vi.spyOn(os, 'hostname').mockReturnValue(HOST)
  vi.useFakeTimers({ now: T_START, toFake: ['Date'] })
  clockControl.ntpOffsetMs = null
  try {
    const db = await import('../../src/core/db/index')
    const events = await import('../../src/core/db/events')
    const ops = await import('../../src/core/db/operators')
    const ingestMod = await import('../../src/core/ingest')
    const { LEGACY_API } = await import('../../src/core/ingest/stamp')
    const { MAX_DATA_DEPTH } = await import('../../src/core/ingest/depth')
    const { exportBundle } = await import('../../src/core/bundle-export')
    const { verifyBundleDir } = await import('../../src/core/bundle-verify')
    const { verifyChainFullAsync } = await import('../../src/core/chain-anchor')
    const { closeHttpBodyIndex } = await import('../../src/core/http-body-index')
    const { drainSpoolAsMain } = await import('../helpers/spool-drain-as-main')

    const step = (): void => { vi.advanceTimersByTime(1000) }
    db.initDB(projectDir)
    db.bindDBEngagement(ENG)
    ingestMod._resetIngest()
    writeOperatorKeys(keysDir, OP)
    ops.createOperator({ id: OP, name: 'Depth Operator', token: ['depth', 'vectors', 'operator'].join('-'), isPrimary: true })
    const who = { engagementId: ENG, operatorId: OP }
    const api = (agentType: string, data: Record<string, unknown>): void => {
      step()
      const r = ingestMod.ingest({ agentType, data, ...who, entrance: LEGACY_API, envelope: { source: 'api', mapper: { id: 'identity', version: '1' } } })
      if (!r.event) throw new Error(`depth vectors: ${agentType}.${String(data.subtype)} was not written (${r.skipped})`)
    }

    step()
    events.insertEvent('system', { subtype: 'session_start' }, who)
    // data (1) → deep, the outermost of 63 arrays (2 … 64) → AWKWARD at 65,
    // so the array at 64 is wrapped.
    api('shell', { subtype: 'command_start', command: 'curl -d @deep.json http://10.0.0.5/api', terminalId: 't-api', pid: 5001, deep: nest(MAX_DATA_DEPTH - 1, AWKWARD) })
    // The proxy puts a parsed JSON body at data.params.body_json (depth 3).
    api('scanner', { subtype: 'http_request_start', flow_id: 'f-deep', method: 'POST', url: 'http://10.0.0.5/api',
      params: { body_json: { a: nest(120, { leaf: 'quokka' }) } } })
    // In-process, exactly at the limit, all arrays.
    step()
    ingestMod.ingestEvent('shell', { subtype: 'command_start', command: 'echo limit', terminalId: 't-in', pid: 5002, deep: nest(MAX_DATA_DEPTH - 1, 'at-limit') }, who)
    // A sender's marker-shaped objects at 63 and at 64.
    step()
    ingestMod.ingestEvent('shell', { subtype: 'command_start', command: 'echo markers', terminalId: 't-in', pid: 5004,
      at63: nest(MAX_DATA_DEPTH - 3, { _collapsed: '[1]' }), at64: nest(MAX_DATA_DEPTH - 2, { _collapsed: 'not json' }) }, who)
    // A spool file: the list at 64 holds three containers, so it is wrapped.
    fs.mkdirSync(spoolDir)
    fs.writeFileSync(path.join(spoolDir, '0001.json'), JSON.stringify({
      agent_type: 'shell',
      data: { subtype: 'command_start', command: 'ls /deep', shell: 'bash', pid: 5003, terminalId: 't-spool', source_timestamp: Date.now() - 30_000,
        deep: nest(MAX_DATA_DEPTH - 2, [[1], { k: [2] }, 'scalar', [[[3]]]]) },
      _identity: who
    }))
    step()
    const drained = drainSpoolAsMain(spoolDir, who)
    if (!drained || drained.replayed !== 1) throw new Error(`depth vectors: spool replay ${JSON.stringify(drained)}`)

    step()
    const bundle = exportBundle(ENG, { outRoot: path.join(work, 'export') })
    const appVerify = appVerifyView(await verifyChainFullAsync() as unknown as Record<string, unknown>)
    const rows = dumpRows(db.getDB())
    closeHttpBodyIndex()
    db.closeDB()

    const collapsed: Record<string, number> = {}
    for (const table of ['events', 'events_logged']) {
      for (const r of rows[table] ?? []) {
        const d = JSON.parse(String(r.data)) as { subtype?: string; command?: string; _ingest?: { collapsed?: number } }
        if (d._ingest?.collapsed) collapsed[`${table}:${String(d.subtype)}:${String(d.command ?? '')}`] = d._ingest.collapsed
      }
    }

    fs.mkdirSync(out, { recursive: true })
    for (const o of OUTPUTS) fs.rmSync(path.join(out, o), { recursive: true, force: true })
    fs.writeFileSync(path.join(out, BUNDLE), packDir(bundle.outDir))
    const seen = unpackTo(path.join(out, BUNDLE), path.join(work, 'unpacked', 'bundle'))
    const expected: DepthExpected = {
      generatedFrom: 'test/fixtures/depth-vectors-generate.ts (Spec 071 FR-097)',
      ...digestRows({ events: rows.events, events_logged: rows.events_logged }),
      collapsed,
      appVerify,
      bundleVerify: verifyBundleDir(seen) as unknown as Record<string, unknown>,
      pythonVerify: runPythonVerifier(seen),
      verifierSha256: sha256(fs.readFileSync(path.join(seen, 'redlog-verify.py')))
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
