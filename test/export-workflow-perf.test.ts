import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }))
import { initDB, closeDB, getDB } from '../src/core/db/index'
import { registerDataExportIpc } from '../src/main/ipc/data-export'
import { addExportEvent } from './helpers/export-fixtures'
import type { IpcContext } from '../src/main/ipc/types'
import { RecentExportStore } from '../src/main/services/recent-export'

// Explicit workload, not a universal latency/RSS promise or a substitute for
// #660's original Windows device/Defender workload. Run without parallel tests.
//
// Size and bound come from the environment (defaults are the original 3,500-event
// workload with no bound):
//   REDLOG_PERF_SHELL         shell events           (default 2500)
//   REDLOG_PERF_FLOWS         HTTP exchanges, 2 events each (default 500)
//   REDLOG_PERF_OUTPUT_LINES  stdout lines per shell event  (default 512)
//   REDLOG_PERF_MAX_STALL_MS  fail if the longest main-thread stall in any
//                             format exceeds this many ms  (default: no check)
//   REDLOG_PERF_TIMEOUT_MS    test timeout                  (default 120000)
const perfNumber = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number, got ${raw}`)
  return value
}
const maxStallMs = process.env.REDLOG_PERF_MAX_STALL_MS ? perfNumber('REDLOG_PERF_MAX_STALL_MS', 0) : null
it.skipIf(process.env.REDLOG_PERF !== '1')('measures complete approved export workflows and verifies every fixture payload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-export-workload-'))
  const report: Record<string, unknown>[] = []
  try {
    initDB(dir)
    const shellCount = perfNumber('REDLOG_PERF_SHELL', 2500), flows = perfNumber('REDLOG_PERF_FLOWS', 500)
    const output = 'full stdout line\n'.repeat(perfNumber('REDLOG_PERF_OUTPUT_LINES', 512))
    getDB().transaction(() => {
      for (let n = 0; n < shellCount; n++) addExportEvent('events', `shell-${n}`, n, { data: { command: `fixture-${n}`, stdout: output } })
      for (let n = 0; n < flows; n++) {
        addExportEvent('events_logged', `req-${n}`, shellCount + n * 2, { agentType: 'scanner', subtype: 'http_request_start', data: { flow_id: `f-${n}`, method: 'GET', url: `http://example.test/${n}` } })
        addExportEvent('events_logged', `res-${n}`, shellCount + n * 2 + 1, { agentType: 'scanner', subtype: 'http_response', data: { flow_id: `f-${n}`, status: 200, response_body: { data: `response-${n}`, encoding: 'text' } } })
      }
    })()
    const project = { id: 'eng-1', name: 'macOS export workload', path: dir, createdAt: 1, lastOpened: 1 }
    const handlers = new Map<string, (_event: unknown, input: any) => any>()
    registerDataExportIpc({ handle: (name: string, fn: any) => handlers.set(name, fn) } as any,
      { getActiveProject: () => project, getCurrentEngagementId: () => project.id, getMainWindow: () => null } as IpcContext,
      { recentExports: new RecentExportStore(path.join(dir, 'machine-data')) })
    for (const format of ['json', 'ndjson', 'bundle', 'har'] as const) {
      const baseline = process.memoryUsage().rss
      let peak = baseline, pulses = 0, previous = performance.now(), worstDelayMs = 0
      const sample = setInterval(() => {
        const now = performance.now(); worstDelayMs = Math.max(worstDelayMs, now - previous - 10); previous = now
        peak = Math.max(peak, process.memoryUsage().rss); pulses++
      }, 10)
      const start = performance.now()
      let resolved: any, executed: any
      try {
        resolved = await handlers.get('data:resolveExportPlan')!({}, { format })
        expect(resolved.ok, JSON.stringify(resolved)).toBe(true)
        executed = await handlers.get('data:executeExportPlan')!({}, { planId: resolved.plan.id })
        expect(executed.ok, JSON.stringify(executed)).toBe(true)
      } finally { clearInterval(sample) }
      const elapsedMs = performance.now() - start
      expect(pulses).toBeGreaterThan(0)
      const file = format === 'bundle' ? path.join(executed.artifactPath, 'events.jsonl') : executed.artifactPath
      const bytes = fs.readFileSync(file)
      if (format === 'har') {
        const entries = JSON.parse(bytes.toString()).log.entries
        expect(entries).toHaveLength(flows)
        for (let n = 0; n < flows; n++) expect(entries[n].response.content.text).toBe(`response-${n}`)
      } else {
        const rows = format === 'json' ? JSON.parse(bytes.toString()).events : bytes.toString().trim().split('\n').map(line => JSON.parse(line))
        const shell = rows.filter((row: any) => (row.agentType ?? row.agent_type) === 'shell')
        expect(shell).toHaveLength(shellCount)
        for (const row of shell) expect((typeof row.data === 'string' ? JSON.parse(row.data) : row.data).stdout).toBe(output)
        if (format !== 'bundle') expect(rows).toHaveLength(shellCount + flows * 2)
        else expect(fs.readFileSync(path.join(executed.artifactPath, 'events_logged.jsonl'), 'utf8').trim().split('\n')).toHaveLength(flows * 2)
      }
      report.push({ format, elapsedMs: Math.round(elapsedMs), baselineRssMiB: Math.round(baseline / 1048576), peakRssMiB: Math.round(peak / 1048576), worstMainDelayMs: Math.round(worstDelayMs), pulses, artifactBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), included: resolved.plan.counts.included })
    }
    const result = { platform: process.platform, arch: process.arch, node: process.version, shellCount, flows, largestShellPayloadBytes: Buffer.byteLength(output), report }
    console.log('EXPORT_WORKFLOW_RESULT ' + JSON.stringify(result))
    if (process.env.REDLOG_PERF_REPORT) fs.writeFileSync(process.env.REDLOG_PERF_REPORT, JSON.stringify(result, null, 2))
    // After the report is out, so a breach still leaves its numbers behind.
    if (maxStallMs !== null) for (const row of report) expect(row.worstMainDelayMs, `${row.format}: longest main-thread stall`).toBeLessThanOrEqual(maxStallMs)
  } finally { closeDB(); fs.rmSync(dir, { recursive: true, force: true }) }
}, perfNumber('REDLOG_PERF_TIMEOUT_MS', 120_000))
