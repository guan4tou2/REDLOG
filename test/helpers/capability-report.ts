// Vitest globalSetup for test/helpers/requires.ts.
//
// Before the workers start it hands them a directory to record each
// requires() call in. After the run it prints one table: which capabilities
// the files asked for, how many had it, how many skipped for want of it.
//
// In CI (REDLOG_CI_CAPABILITIES=1) it also probes every capability once —
// including the ones no file asks for through requires() yet — and writes
// test-results/capabilities-<platform>.json. scripts/verify-skip-baseline.mjs
// reads that file: a capability test/capabilities.json marks "required" that
// this machine lacks fails the leg; an "unknown" one is printed with what the
// machine actually has, so the manifest can be set from the first run.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CAPABILITIES, expectation, probe, type Capability } from './requires'

interface Row { file: string; cap: Capability; ok: boolean; detail: string; want: string | null }

const ROOT = path.resolve(__dirname, '..', '..')

export default function setup(): () => void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-capabilities-'))
  process.env.REDLOG_CAPABILITY_LOG = dir

  return () => {
    const file = path.join(dir, 'records.jsonl')
    const rows: Row[] = fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row)
      : []
    fs.rmSync(dir, { recursive: true, force: true })

    const byCap = new Map<Capability, Row[]>()
    for (const r of rows) byCap.set(r.cap, [...(byCap.get(r.cap) ?? []), r])
    if (byCap.size) {
      const lines = ['capability            files  ran  skipped  manifest']
      for (const [cap, rs] of byCap) {
        const ran = new Set(rs.filter((r) => r.ok).map((r) => r.file)).size
        const all = new Set(rs.map((r) => r.file)).size
        lines.push(`${cap.padEnd(22)}${String(all).padStart(5)}${String(ran).padStart(5)}${String(all - ran).padStart(9)}  ${rs[0].want ?? 'not enforced (local)'}`)
      }
      console.log(`\nrequires() on ${process.platform}:\n${lines.join('\n')}\n`)
    }

    if (process.env.REDLOG_CI_CAPABILITIES !== '1') return
    const env: Record<string, { ok: boolean; detail: string; manifest: string | null }> = {}
    for (const cap of CAPABILITIES) {
      let state
      try { state = probe(cap) } catch (e) { state = { ok: false, detail: `probe threw: ${(e as Error).message.split('\n')[0]}` } }
      env[cap] = { ...state, manifest: expectation(cap) }
    }
    const out = path.join(ROOT, 'test-results', `capabilities-${process.platform}.json`)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, JSON.stringify({ platform: process.platform, capabilities: env }, null, 2) + '\n')
  }
}
