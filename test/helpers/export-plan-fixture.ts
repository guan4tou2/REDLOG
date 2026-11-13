import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDB, getDB } from '../../src/core/db/index'
import { queryActivityPage } from '../../src/core/db/activity-queries'
import { parseQuery } from '../../src/core/query/contract'
import { addExportEvent, addExportAttachment } from './export-fixtures'
import type { ExportRequest } from '../../src/core/export-plan'

// One project that makes every counter, digest and attachment row the export
// plan reports non-trivial: scope, personal and excluded hosts, do-not-export
// rows, sanitized rows, truncation, pauses, gaps, recovered recordings, flows
// with and without a request, screenshots, casts, bodies and artifacts, and one
// Activity whose companions sit in the other tier. Everything is fixed, so the
// same code computes the same plan on any machine.
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
export type PlanFixture = { dir: string; activity: { snapshot: ReturnType<typeof queryActivityPage>['snapshot']; anchorEventId: string; projectId: string } }

export function addPlanFixtureEvent(table: 'events' | 'events_logged', id: string, ts: number, targetId: string | null, agentType: string, subtype: string, data: Record<string, unknown> = {}): void {
  addExportEvent(table, id, ts, { agentType, subtype, targetId, data })
}
const ev = addPlanFixtureEvent

/** Opens a new project database in a temp directory; the caller closes it and removes `dir`. */
export function createPlanFixture(): PlanFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-plan-fixture-'))
  initDB(dir)
  fs.writeFileSync(path.join(dir, 'config.yaml'), ['engagement:', '  id: eng-1', 'scope:', '  targets:', '    - in.test', '  excludeTargets:', '    - excluded.test', '  personalDomains:', '    - personal.test'].join('\n'))
  const targets = ['in.test', 'out.test', 'excluded.test', 'personal.test', null, 'IN.test']
  getDB().transaction(() => {
    for (let n = 0; n < 120; n++) {
      const target = targets[n % targets.length]
      const data: Record<string, unknown> = { command: `run-${n}`, stdout: `line ${n}\n`.repeat(1 + n % 5), terminalId: `term-${n % 3}`, command_id: `cmd-${n}` }
      if (n % 7 === 0) data.stdout_truncated = true
      if (n % 11 === 0) data.stream_state = 'interrupted'
      if (n % 13 === 0) data.io = { ref: `casts/t${n % 2}.cast`, truncated: n % 26 === 0 }
      ev('events', `shell-${String(n).padStart(3, '0')}`, 1000 + n * 3, target, 'shell', 'command_end', data)
    }
    for (let n = 0; n < 4; n++) {
      ev('events', `rec-end-${n}`, 2000 + n, 'in.test', 'shell', 'session_end', { recovered: n % 2 === 0, terminalId: 'term-0', castPath: 'casts/t0.cast' })
      ev('events', `orphan-${n}`, 2010 + n, 'in.test', 'shell', 'command_boundary', { reason: n % 2 === 0 ? 'recovered-orphan' : 'normal' })
      ev('events', `pause-${n}`, 2020 + n, null, 'system', 'recording_paused', {})
    }
    const gaps: Array<[string, string, Record<string, unknown>]> = [
      ['scanner', 'capture_gap', { reason: 'queue-full', skipped_units: 4 }],
      ['scanner', 'capture_gap', { reason: 'queue-full' }],
      ['system', 'capture_gap', { skipped_units: 2 }],
      ['system', 'capture_gap', { reason: 'delivery-unconfirmed', skipped_units: 9 }],
      ['system', 'capture_gap', { reason: 'spool', source: 'hook-spool', intentional: true }],
      ['system', 'capture_gap', { reason: 'spool', source: 'other', intentional: true, skipped_units: 3, capture_delivery: 'unknown' }],
      ['shell', 'capture_gap', { reason: 'ignored-agent' }]
    ]
    gaps.forEach(([agent, subtype, data], n) => ev('events', `gap-${n}`, 2100 + n, 'in.test', agent, subtype, data))
    for (let n = 0; n < 40; n++) {
      const host = ['in.test', 'out.test', 'excluded.test', 'personal.test'][n % 4]
      ev('events_logged', `req-${n}`, 3000 + n * 4, host, 'scanner', 'http_request_start', { flow_id: `f-${n}`, method: 'GET', url: `http://${host}/p${n}`, host })
      ev('events_logged', `res-${n}`, 3001 + n * 4, host, 'scanner', 'http_response', { flow_id: `f-${n}`, status: n % 3 ? 200 : 404, ...(n % 5 === 0 ? { response_body_ref: { sha256: n % 10 === 0 ? HASH_A : HASH_B, size: 7, truncated: n % 20 === 0 } } : {}) })
      if (n % 6 === 0) ev('events_logged', `chunk-${n}`, 3002 + n * 4, host, 'scanner', 'http_response_chunk', { flow_id: `f-${n}`, url: `http://${host}/p${n}` })
    }
    for (let n = 0; n < 9; n++) {
      const host = ['in.test', 'out.test', 'excluded.test'][n % 3]
      ev('events_logged', `ws-${n}`, 3500 + n, host, 'scanner', 'ws_message', { flow_id: `stream-${n % 4}`, url: `ws://${host}/s${n % 4}` })
    }
    ev('events_logged', 'chunk-malformed', 3600, 'in.test', 'scanner', 'http_response_chunk', { flow_id: 'bad', url: 'not a url' })
    ev('events_logged', 'chunk-ftp', 3601, 'in.test', 'scanner', 'http_response_chunk', { flow_id: 'ftp', url: 'ftp://out.test/x' })
    for (let n = 0; n < 6; n++) {
      ev('events', `shot-${n}`, 3700 + n, n % 2 ? 'out.test' : 'in.test', 'screenshot', 'screenshot', { filename: `s${n % 4}.png` })
    }
    ev('events', 'artifact-in', 3800, 'in.test', 'file_transfer', 'artifact_added', { stored: 'artifacts/in.txt' })
    ev('events', 'artifact-out', 3801, 'out.test', 'file_transfer', 'artifact_added', { stored: 'artifacts/out.txt' })
    ev('events', 'artifact-missing', 3802, 'in.test', 'file_transfer', 'artifact_added', { stored: 'artifacts/missing.txt' })
    ev('events', 'twin-a', 3900, 'in.test', 'shell', 'command_end', { command: 'same', terminalId: 'twin' })
    ev('events', 'twin-b', 3900, 'in.test', 'shell', 'command_end', { command: 'same', terminalId: 'twin' })
    ev('events_logged', 'twin-c', 3900, 'in.test', 'shell', 'command_output', { command: 'same', terminalId: 'twin' })
    const op = { shell: 'zsh', terminalId: 'term-op', command_id: 'cmd-op', command: 'unique-op' }
    ev('events', 'op-begin', 4000, 'in.test', 'shell', 'command_start', op)
    ev('events', 'op-end', 4001, 'in.test', 'shell', 'command_end', { ...op, stdout: 'saved', stdout_truncated: true, io: { ref: 'casts/t0.cast' } })
    ev('events_logged', 'op-chunk', 4002, 'out.test', 'shell', 'command_output', { ...op, stdout: 'late' })
    ev('events', 'op-same-session', 4003, 'in.test', 'shell', 'command_end', { ...op, command_id: 'cmd-op-2', io: { ref: 'casts/t0.cast' } })
    ev('events', 'op-other-session', 4004, 'in.test', 'shell', 'command_end', { ...op, terminalId: 'term-other' })
    const db = getDB()
    for (const id of ['shell-004', 'shell-011', 'req-6', 'res-8']) db.prepare('INSERT INTO do_not_export (event_id, created_at) VALUES (?, 1)').run(id)
    for (const id of ['shell-001', 'shell-002', 'res-1', 'shot-1']) {
      db.prepare("INSERT INTO sanitized_events (source_event_id, field, sanitized_value, replacement_sha256, created_at, sanitized_event_id) VALUES (?, 'stdout', '[redacted]', 'x', 1, 'san')").run(id)
    }
  })()
  addExportAttachment(dir, 'screenshots/s0.png', 'png0')
  addExportAttachment(dir, 'screenshots/s1.png', 'png1')
  addExportAttachment(dir, 'screenshots/loose.png', 'loose')
  addExportAttachment(dir, 'casts/t0.cast', '{}\n[0,"o","a"]\n[1,"o","partial')
  addExportAttachment(dir, 'casts/t1.cast', '{}\n[0,"o","b"]\n')
  addExportAttachment(dir, 'casts/unreferenced.cast', '{}\n')
  addExportAttachment(dir, `http-bodies/${HASH_A}.body`, 'body-a')
  addExportAttachment(dir, 'artifacts/in.txt', 'artifact in')
  addExportAttachment(dir, 'artifacts/out.txt', 'artifact out')
  const parsed = parseQuery('unique-op')
  if (!parsed.ok) throw new Error('query')
  return { dir, activity: { snapshot: queryActivityPage({ projectId: 'eng-1', parsed: parsed.parsed }).snapshot, anchorEventId: 'op-begin', projectId: 'eng-1' } }
}

export const planProject = (dir: string) => ({ id: 'eng-1', name: 'plan', path: dir, createdAt: 1, lastOpened: 1 })

export const planCases = (activity: PlanFixture['activity']): Array<[string, ExportRequest]> => [
  ['json-all', { format: 'json', maskOutOfScope: false }],
  ['json-masked', { format: 'json', maskOutOfScope: true }],
  ['json-scrub', { format: 'json', maskOutOfScope: true, scrubPii: true }],
  ['ndjson-all', { format: 'ndjson', maskOutOfScope: false }],
  ['ndjson-masked', { format: 'ndjson', maskOutOfScope: true }],
  ['timeline-range', { format: 'timeline', maskOutOfScope: true, subset: { kind: 'time-range', since: 1100, before: 3100 } }],
  ['json-range-target', { format: 'json', maskOutOfScope: false, subset: { kind: 'time-range', since: 1000, before: 4000, targetId: 'in.test' } }],
  ['json-empty', { format: 'json', subset: { kind: 'time-range', since: 5, before: 6 } }],
  ['har-all', { format: 'har' }],
  ['har-range', { format: 'har', subset: { kind: 'time-range', since: 3000, before: 3100 } }],
  ['json-selection-query', { format: 'json', maskOutOfScope: true, subset: { kind: 'selection', projection: 'events', filter: {}, query: 'run-1' } }],
  ['json-selection-filter', { format: 'ndjson', subset: { kind: 'selection', projection: 'events', filter: { targetId: 'out.test' } } }],
  ['har-selection-http', { format: 'har', subset: { kind: 'selection', projection: 'http', filter: {}, http: { statusPrefix: '4' } } }],
  ['har-selection-http-host', { format: 'har', subset: { kind: 'selection', projection: 'http', filter: { since: 3000, before: 3200 }, http: { host: 'in.test' } } }],
  // Stream-only flows (ws, chunk-only) the HTTP view leaves out: the one count that needs a second look at flows the selection did not pick.
  ['har-selection-http-window', { format: 'har', subset: { kind: 'selection', projection: 'http', filter: { since: 3400, before: 3700 } } }],
  ['har-selection-http-window-host', { format: 'har', subset: { kind: 'selection', projection: 'http', filter: { since: 3400, before: 3700 }, http: { host: 'in.test' } } }],
  ['har-selection-http-text', { format: 'har', subset: { kind: 'selection', projection: 'http', filter: {}, http: { text: 'p1' } } }],
  ['json-selection-http', { format: 'json', maskOutOfScope: false, subset: { kind: 'selection', projection: 'http', filter: {} } }],
  ['json-activity', { format: 'json', maskOutOfScope: false, subset: { kind: 'activity', ...activity } }],
  ['ndjson-session', { format: 'ndjson', maskOutOfScope: true, subset: { kind: 'session', ...activity } }],
  ['bundle-all', { format: 'bundle', maskOutOfScope: false }],
  ['bundle-masked', { format: 'bundle', maskOutOfScope: true }],
  ['bundle-exclude', { format: 'bundle', maskOutOfScope: true, excludeAttachments: ['casts/t1.cast', `http-bodies/${HASH_A}.body`, 'screenshots/loose.png'] }],
  ['bundle-range', { format: 'bundle', maskOutOfScope: true, subset: { kind: 'time-range', since: 1000, before: 3800 } }],
  ['bundle-session', { format: 'bundle', maskOutOfScope: false, subset: { kind: 'session', ...activity }, includeAttachments: ['casts/t0.cast'] }],
]
