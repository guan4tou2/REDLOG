import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDB, closeDB } from '../src/core/db/index'
import {
  aggregateTargets, queryEvents, queryEventsPage, countEvents, queryHttpFlowPage
} from '../src/core/db/events'
import { registerDataExportIpc } from '../src/main/ipc/data-export'
import { ExportPlanRegistry } from '../src/core/export-plan'
import type { IpcContext } from '../src/main/ipc/types'
import type { ProjectMeta } from '../src/core/project-manager'
import { insertFixtureRow, type FixtureRow } from './helpers/timeline-query-fixture'

type Handler = (_event: unknown, input?: never) => unknown

const T0 = 1_700_000_000_000
let n = 0
const row = (table: FixtureRow['table'], targetId: string | null, extra: Partial<FixtureRow> = {}): FixtureRow => {
  n += 1
  return {
    table, id: `tc-${n}`, timestamp: T0 - n * 1000, agentType: 'shell', subtype: 'command_end',
    operatorId: 'op-1', targetId, data: { command: `curl ${targetId ?? 'x'}` }, ...extra
  }
}

function walkPage(filter: Record<string, unknown>): number {
  let count = 0
  let cursor: string | null = null
  do {
    const page = queryEventsPage({ ...filter, limit: 3, cursor })
    count += page.items.length
    cursor = page.nextCursor
  } while (cursor)
  return count
}

// SPEC-target-identity: the target is `target_id`, compared lowercased. The
// Targets page grouped `LOWER(target)`, and every filter compared the stored
// spelling exactly, so a target recorded as `Example.COM` and `example.com`
// had one count on the Targets page and another everywhere it was opened.
describe('one case-insensitive target predicate', () => {
  let dir: string
  let handlers: Map<string, Handler>

  beforeEach(() => {
    n = 0
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-033-target-'))
    initDB(dir)
    const rows = [
      row('events', 'Example.COM'), row('events_logged', 'Example.COM'), row('events', 'Example.COM'),
      row('events', 'example.com'), row('events_logged', 'example.com'),
      row('events', '10.0.0.5'), row('events_logged', '10.0.0.5'),
      row('events', '10.0.0.50'), row('events_logged', '10.0.0.50'),
      row('events_logged', null, { agentType: 'scanner', subtype: 'connection', data: { remote_addr: '10.0.0.5' } }),
      row('events_logged', null, { agentType: 'scanner', subtype: 'http_request_start', data: { host: '10.0.0.5' } }),
      // Two HTTP flows, one per spelling.
      row('events_logged', 'Example.COM', { agentType: 'scanner', subtype: 'http_request_start', data: { flow_id: 'f1', host: 'Example.COM' } }),
      row('events_logged', 'example.com', { agentType: 'scanner', subtype: 'http_request_start', data: { flow_id: 'f2', host: 'example.com' } })
    ]
    for (const r of rows) insertFixtureRow(r)

    const active: ProjectMeta = { id: 'eng-1', name: 'Test', path: dir, createdAt: 1, lastOpened: 1 }
    handlers = new Map()
    const ipcMain = { handle: (name: string, fn: Handler) => { handlers.set(name, fn) } }
    const ctx = {
      getActiveProject: () => active,
      getMainWindow: () => null,
      getOverlayWindow: () => null,
      getCurrentEngagementId: () => active.id,
      getCurrentOperatorId: () => null,
      send: () => undefined,
      triggerBookmark: () => undefined,
      triggerInstantMark: () => ({ ok: false })
    } as unknown as IpcContext
    registerDataExportIpc(ipcMain as never, ctx, { planRegistry: new ExportPlanRegistry({ now: () => T0 }) })
  })

  afterEach(() => {
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('the Targets count, the detail query and every filter agree across casings', () => {
    const agg = aggregateTargets().find((t) => t.target.toLowerCase() === 'example.com')
    expect(agg?.eventCount).toBe(7)
    expect(queryEvents({ targetId: 'example.com', limit: -1 })).toHaveLength(7)
    expect(walkPage({ targetId: 'EXAMPLE.com' })).toBe(7)
    expect(countEvents({ filter: { targetId: 'Example.COM' } })).toBe(7)
    expect(queryHttpFlowPage({ targetId: 'EXAMPLE.COM' }).flowCount).toBe(2)
  })

  it('selects neither a longer address nor an observation that names it', () => {
    expect(walkPage({ targetId: '10.0.0.5' })).toBe(2)
    expect(countEvents({ filter: { targetId: '10.0.0.5' } })).toBe(2)
  })

  // Export reads the target through the same predicate (research R3): an
  // export limited to a target selects every casing, and executes what it
  // previewed.
  it('an export limited to a target selects every casing, as previewed', () => {
    // `timeline` is a format that takes a bounded subset, as the Timeline's own export does.
    const request = { format: 'timeline', subset: { kind: 'time-range', since: T0 - 100_000, before: T0, targetId: 'EXAMPLE.com' } }
    const resolved = handlers.get('data:resolveExportPlan')?.({}, request as never) as {
      ok: true; plan: { id: string; counts: { included: number } }
    }
    expect(resolved, JSON.stringify(resolved)).toMatchObject({ ok: true })
    expect(resolved.plan.counts.included).toBe(7)
    const executed = handlers.get('data:executeExportPlan')?.({}, { planId: resolved.plan.id } as never) as {
      ok: true; counts: { included: number }
    }
    expect(executed).toMatchObject({ ok: true, counts: { included: 7 } })
  })
})
