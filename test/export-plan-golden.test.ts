import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { closeDB } from '../src/core/db/index'
import { closeHttpBodyIndex } from '../src/core/http-body-index'
import { buildExportPlan } from '../src/core/export-planning'
import type { ExportRequest } from '../src/core/export-plan'
import { createPlanFixture, planCases, planProject, type PlanFixture } from './helpers/export-plan-fixture'
import GOLDEN from './fixtures/export-plan-golden.json'

// What `buildExportPlan` computes, pinned. GOLDEN was taken from the
// implementation that read the snapshot once per counter and once more for the
// digest (origin/main fd9754bb), on this exact fixture, before the plan step
// was folded into a single walk. `counts`, `selectedEventIds`, both digests and
// the attachment listing must stay byte-identical across any change to how the
// plan is computed. Regenerate only for a deliberate contract change:
//   REDLOG_PRINT_GOLDEN=1 npx vitest run test/export-plan-golden.test.ts
let fixture: PlanFixture
beforeEach(() => { fixture = createPlanFixture() })
afterEach(() => { closeDB(); closeHttpBodyIndex(); fs.rmSync(fixture.dir, { recursive: true, force: true }) })

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function observePlan(dir: string, request: ExportRequest) {
  const plan = buildExportPlan(planProject(dir) as never, request)
  return {
    counts: plan.counts,
    ids: { n: plan.selectedEventIds.length, sha: sha(plan.selectedEventIds) },
    evidence: plan.selectedEvidenceDigest,
    attachmentDigest: plan.attachmentDigest,
    attachments: sha(plan.attachments)
  }
}

describe('buildExportPlan', () => {
  const names = planCases({} as never).map(([name]) => name)
  it('has a golden for every case and no stale ones', () => {
    if (process.env.REDLOG_PRINT_GOLDEN) return
    expect(Object.keys(GOLDEN).sort()).toEqual([...names].sort())
  })

  it.each(names)('%s computes what the multi-walk plan computed', name => {
    const request = planCases(fixture.activity).find(([n]) => n === name)![1]
    // A single JSON round trip drops `undefined` the way the golden file did.
    const seen = JSON.parse(JSON.stringify(observePlan(fixture.dir, request)))
    if (!/empty|window/.test(name)) expect(seen.ids.n).toBeGreaterThan(0)
    if (process.env.REDLOG_PRINT_GOLDEN) console.log(`GOLDEN ${name} ${JSON.stringify(seen)}`)
    else expect(seen).toEqual((GOLDEN as Record<string, unknown>)[name])
  })

  it('exercises every counter the plan reports, so the pin is not trivially zero', () => {
    const seen = observePlan(fixture.dir, { format: 'json', maskOutOfScope: true })
    expect(seen.counts).toMatchObject({ excludedDoNotExport: 4, excludedPersonal: expect.any(Number) })
    for (const key of ['excludedPersonal', 'outOfScopeHttpFlows', 'maskedOutOfScope', 'sanitized', 'unsupported', 'truncatedOutputs', 'pauseWindows', 'interruptedRecordings', 'interruptedCommands'] as const) {
      expect(seen.counts[key], key).toBeGreaterThan(0)
    }
    expect(seen.counts.captureGaps!.length).toBeGreaterThan(1)
    expect(observePlan(fixture.dir, { format: 'har' }).counts.partialHttpFlows).toBeGreaterThan(0)
    const outside = observePlan(fixture.dir, { format: 'har', subset: { kind: 'selection', projection: 'http', filter: { since: 3400, before: 3700 } } }).counts
    expect(outside.partialHttpFlowsOutside).toBeGreaterThan(0)
    expect(observePlan(fixture.dir, { format: 'har', subset: { kind: 'selection', projection: 'http', filter: {}, http: { statusPrefix: '4' } } }).counts.exchanges).toBeGreaterThan(0)
    expect(observePlan(fixture.dir, { format: 'bundle' }).counts.attachmentsIncluded).toBeGreaterThan(0)
  })
})
