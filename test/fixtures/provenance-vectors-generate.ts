// Generator for test/fixtures/provenance-vectors/ — new rows, stamped by the
// receiver (`data._ingest`, Spec 071 FR-005), exported as one sealed bundle,
// with what both verifiers say about it (T031).
//
// The other half of test/fixtures/golden-pre071: that fixture is rows written
// before the stamp, held so they never change; this one is rows written with
// it, held so a change to what the stamp writes is seen, and so both verifiers
// are shown accepting it. FR-020 keeps the hash formula; `_ingest` is inside
// `data`, so the vectors are the proof that the app's verifier and
// tools/redlog-verify.py serialise it alike (FR-006).
//
// Run through the test, never by hand:
//
//   REDLOG_WRITE_PROVENANCE_VECTORS=1 npx vitest run test/provenance-vectors.test.ts
//
// rewrites the fixture; without the variable the test regenerates into a
// temporary directory and fails if the rows differ from what is committed.
// Regenerate only in a commit that changes what new rows carry, and say so.
//
// Deterministic the same way golden-pre071-generate.ts is: faked wall clock
// with the monotonic clock following it, counted ids, fixed host name, and the
// operator's Ed25519 key derived from a public seed at run time.
//
// The doors, each with the stamp it must carry:
//   in-process      session_start written straight through insertEvent, as
//                   main does on every open (FR-022); ingestEvent; the
//                   export's own rows (logged digest, seal)
//   derived         a companion (a pivot) the pipeline derives from a command
//   legacy-api      ingest() with the entrance POST /api/events passes, chained
//                   and logged; with a forged stamp and receiver-owned keys in
//                   the data (`stripped`); beside the receiver's own `_raw`,
//                   `_source_time_rejected` and `_clock_anomaly`
//   legacy-handoff  a hook spool file replayed by main's drain

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { vi } from 'vitest'
import {
  appVerifyView, clockControl, digestRows, dumpRows, packDir, runPythonVerifier, unpackTo, writeOperatorKeys, type GoldenExpected
} from './golden-pre071-generate'

export const ENG = 'eng-provenance-vectors'
export const OP = 'op-provenance'
export const T_START = Date.UTC(2026, 10, 13, 10, 0, 0)
const HOST = 'provenance-vectors-host'

export const BUNDLE = 'bundle.json.gz'
const OUTPUTS = [BUNDLE, 'expected.json'] as const

export interface ProvenanceExpected {
  generatedFrom: string
  rows: GoldenExpected['rows']
  rowsSha256: string
  /** Each row's stamp without its event_id, in rowid order per tier. */
  stamps: Record<string, Array<{ id: string; subtype: string | null; stamp: Record<string, unknown> }>>
  appVerify: Record<string, unknown>
  bundleVerify: Record<string, unknown>
  pythonVerify: { status: number | null; stdout: string; stderr: string }
}

/** Faking the clock module for the generator; the monotonic counter follows
 *  the faked wall clock from this fixture's start. */
export function clockMockVectors(real: Record<string, unknown>): Record<string, unknown> {
  return {
    ...real,
    monotonicNs: () => String(BigInt(Date.now() - T_START) * 1_000_000n + 5_000_000_000n),
    getNtpOffsetMs: () => clockControl.ntpOffsetMs
  }
}

export function stampsOf(rows: Record<string, Array<Record<string, unknown>>>): ProvenanceExpected['stamps'] {
  const out: ProvenanceExpected['stamps'] = {}
  for (const table of ['events', 'events_logged']) {
    out[table] = (rows[table] ?? []).map((r) => {
      const { event_id: _id, ...stamp } = (JSON.parse(String(r.data)) as { _ingest?: Record<string, unknown> })._ingest ?? {}
      return { id: String(r.id), subtype: (r.subtype as string | null) ?? null, stamp }
    })
  }
  return out
}

/**
 * Write the vectors into `out`: bundle.json.gz (packed; see packDir) and
 * expected.json. Only those two are replaced.
 *
 * Call with `vi.doMock(<clock module>, clockMockVectors)` in place and modules
 * reset; the other fakes are installed and removed here.
 */
export async function generateProvenanceVectors(out: string): Promise<ProvenanceExpected> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-provenance-vectors-'))
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
    ops.createOperator({ id: OP, name: 'Provenance Operator', token: ['provenance', 'vectors', 'operator'].join('-'), isPrimary: true })
    const who = { engagementId: ENG, operatorId: OP }
    const API = { source: 'api', mapper: { id: 'identity', version: '1' } }
    const api = (agentType: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}): void => {
      step()
      const r = ingestMod.ingest({ agentType, data, ...who, entrance: LEGACY_API, envelope: { ...API, ...extra } })
      if (!r.event) throw new Error(`vectors: ${agentType}.${String(data.subtype)} was not written (${r.skipped})`)
    }

    // in-process, straight through insertEvent: what main writes on every open.
    step()
    events.insertEvent('system', { subtype: 'session_start' }, who)

    // legacy-api: chained, logged, forged, raw, rejected source time.
    api('shell', { subtype: 'command_start', command: 'nmap -sV 10.0.0.5', terminalId: 't-api', pid: 4001, command_id: 'c-1', source_timestamp: Date.now() })
    api('scanner', { subtype: 'http_request_start', flow_id: 'f-1', method: 'GET', url: 'http://10.0.0.5/' })
    api('shell', { subtype: 'command_start', command: 'id', terminalId: 't-api', pid: 4002,
      _ingest: { v: 1, door: 'in-process', producer: 'builtin-terminal', auth: 'in-process', credential: null },
      _raw: { sha256: '0'.repeat(64), size: 0 }, _clock_anomaly: { reason: 'forged' }, _source_time_rejected: { value: 0, reason: 'forged' } })
    api('shell', { subtype: 'command_start', command: 'uname -a', terminalId: 't-api', pid: 4003 },
      { raw: JSON.stringify({ agent_type: 'shell', data: { subtype: 'command_start', command: 'uname -a' } }) })
    api('shell', { subtype: 'command_start', command: 'date', terminalId: 't-api', pid: 4004, source_timestamp: 1_763_000_000 })

    // in-process, with the receiver's clock anomaly; derived, a pivot.
    step()
    clockControl.ntpOffsetMs = 45_000
    ingestMod.ingestEvent('shell', { subtype: 'command_start', command: 'whoami', terminalId: 'term-1', pid: 4005, source: 'builtin-terminal' }, who)
    clockControl.ntpOffsetMs = null
    step()
    const pivot = ingestMod.ingest({ agentType: 'shell', data: { subtype: 'command_start', command: 'sshuttle -r user@jump 10.10.0.0/16', terminalId: 'term-1', pid: 4006 }, ...who })
    if (!pivot.companions.some((c) => c.agentType === 'pivot')) throw new Error('vectors: no pivot companion')

    // legacy-handoff: a hook spool file.
    fs.mkdirSync(spoolDir)
    fs.writeFileSync(path.join(spoolDir, '0001.json'), JSON.stringify({
      agent_type: 'shell', data: { subtype: 'command_start', command: 'ls /tmp', shell: 'bash', pid: 4007, terminalId: 't-spool', source_timestamp: Date.now() - 30_000 },
      _identity: who
    }))
    step()
    const drained = drainSpoolAsMain(spoolDir, who)
    if (!drained || drained.replayed !== 1) throw new Error(`vectors: spool replay ${JSON.stringify(drained)}`)

    step()
    const bundle = exportBundle(ENG, { outRoot: path.join(work, 'export') })

    const appVerify = appVerifyView(await verifyChainFullAsync() as unknown as Record<string, unknown>)
    const rows = dumpRows(db.getDB())
    closeHttpBodyIndex()
    db.closeDB()

    fs.mkdirSync(out, { recursive: true })
    for (const o of OUTPUTS) fs.rmSync(path.join(out, o), { recursive: true, force: true })
    fs.writeFileSync(path.join(out, BUNDLE), packDir(bundle.outDir))
    // What the verifiers say is taken from the packed bytes, unpacked, as the
    // test will see them.
    const seen = unpackTo(path.join(out, BUNDLE), path.join(work, 'unpacked', 'bundle'))
    const { events: chained, events_logged: logged } = rows
    const expected: ProvenanceExpected = {
      generatedFrom: 'test/fixtures/provenance-vectors-generate.ts (Spec 071 T031)',
      ...digestRows({ events: chained, events_logged: logged }),
      stamps: stampsOf(rows),
      appVerify,
      bundleVerify: verifyBundleDir(seen) as unknown as Record<string, unknown>,
      pythonVerify: runPythonVerifier(seen)
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
