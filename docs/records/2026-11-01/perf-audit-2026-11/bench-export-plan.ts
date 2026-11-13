// The export preview (`data:resolveExportPlan`) on a large project — the phase
// that runs in the export worker, so the main-process profile of measure-app.mjs
// cannot see it.
//
//   node docs/records/2026-11-01/perf-audit-2026-11/run.mjs bench-export-plan.ts [--prof] -- <projectDir> [format]
//
// Builds the same plan the IPC handler does (whole project, default options)
// and prints each step's wall time. Run against a copy of the project.

import { initDB } from '../../../../src/core/db/index'
import { buildExportPlan } from '../../../../src/core/export-planning'
import path from 'node:path'

const [projectDir, format = 'ndjson'] = process.argv.slice(2)
initDB(projectDir)
const project = { id: path.basename(projectDir), name: 'perf', path: projectDir, createdAt: 0, lastOpened: 0 }
const t0 = performance.now()
const plan = buildExportPlan(project as never, { format, subset: { kind: 'all' } } as never)
console.log(JSON.stringify({ format, planMs: Math.round(performance.now() - t0), included: plan.counts.included, examined: plan.counts.examined }))
