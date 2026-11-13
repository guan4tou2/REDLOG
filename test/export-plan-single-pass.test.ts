import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Count database walks, not calls to a helper: `iterateSnapshotEvents` calls
// itself from inside its own module, which a spy on the export cannot see.
// Every walk of the snapshot starts with one `queryEventsPage` call that has
// no cursor, and every further page of it carries one.
const walks = vi.hoisted(() => ({ starts: 0, pages: 0 }))
vi.mock('../src/core/db/events', async importOriginal => {
  const original = await importOriginal<typeof import('../src/core/db/events')>()
  return {
    ...original,
    queryEventsPage: ((opts: Parameters<typeof original.queryEventsPage>[0]) => {
      walks.pages++
      if (!opts.cursor) walks.starts++
      return original.queryEventsPage(opts)
    }) as typeof original.queryEventsPage
  }
})

import { closeDB, getDB } from '../src/core/db/index'
import { closeHttpBodyIndex } from '../src/core/http-body-index'
import { buildExportPlan } from '../src/core/export-planning'
import type { ExportRequest } from '../src/core/export-plan'
import { addPlanFixtureEvent, createPlanFixture, planProject, type PlanFixture } from './helpers/export-plan-fixture'

// `buildExportPlan` used to read the whole snapshot eight times for an event
// format (once to select, then once per figure and once more for the digest):
// 137 s on a 198k-event project (#660). The figures are folded into the
// selection walk now. test/export-plan-golden.test.ts pins what they say.
let fixture: PlanFixture
beforeEach(() => { fixture = createPlanFixture() })
afterEach(() => { closeDB(); closeHttpBodyIndex(); fs.rmSync(fixture.dir, { recursive: true, force: true }) })

function measured(request: ExportRequest) {
  walks.starts = 0
  walks.pages = 0
  const plan = buildExportPlan(planProject(fixture.dir) as never, request)
  return { starts: walks.starts, pages: walks.pages, included: plan.counts.included, examined: plan.counts.examined }
}

describe('the export plan reads the snapshot once for the event formats', () => {
  it.each([
    ['json', { format: 'json' }],
    ['ndjson, masked', { format: 'ndjson', maskOutOfScope: true }],
    ['timeline, range', { format: 'timeline', subset: { kind: 'time-range', since: 1000, before: 3000 } }],
    ['har', { format: 'har' }],
    ['json, scrubbed', { format: 'json', scrubPii: true }]
  ] satisfies Array<[string, ExportRequest]>)('%s: one walk', (_name, request) => {
    const { starts, included } = measured(request)
    expect(included).toBeGreaterThan(0)
    expect(starts).toBe(1)
  })

  it('pages the snapshot once, however many pages it spans', () => {
    getDB().transaction(() => {
      for (let n = 0; n < 1300; n++) addPlanFixtureEvent('events', `bulk-${n}`, 5000 + n, 'in.test', 'shell', 'command_end', { command: `bulk-${n}` })
    })()
    const { starts, pages, included, examined } = measured({ format: 'ndjson' })
    expect(included).toBeGreaterThan(1300)
    expect(starts).toBe(1)
    expect(pages).toBe(Math.ceil(examined / 512))
  })

  it('a HAR of the HTTP view adds only the walk its stream-only-flow count needs', () => {
    const http = { kind: 'selection', projection: 'http', filter: {} } as const
    const har = measured({ format: 'har', subset: http })
    // Resolving a selection is its own reader (it pages the query, then walks
    // the snapshot for companions); the figures add nothing to it. The HAR-only
    // stream-only-flow count is the one extra walk, since it must see flows
    // the selection left out.
    expect(har.starts).toBe(measured({ format: 'json', subset: http }).starts + 1)
  })

  it('the bundle no longer walks per figure: its only re-reads are the attachment listing', () => {
    const bundle = measured({ format: 'bundle' })
    const ndjson = measured({ format: 'ndjson' })
    // selection + figures are one walk, as for any format; the rest is
    // listExportAttachments and countExportAttachments.
    expect(bundle.starts).toBeGreaterThan(ndjson.starts)
    expect(bundle.starts).toBeLessThanOrEqual(ndjson.starts + 9)
  })
})
