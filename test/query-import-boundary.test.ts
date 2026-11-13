// Spec 074 T012: the main process and the HTTP API server must stop importing
// the read-side symbols that Phase 3 moves into the query service, and today
// they import a lot of them. This is the "before": a ratchet over those
// imports, in the shape of test/single-ingest-door.test.ts and
// test/mutation-guard.test.ts. Phase 3 deletes entries as it moves a read
// behind `QueryService`; Phase 8 asserts the table is empty.
//
// What is counted: an import, in a file under src/main/** or in
// src/core/api-server.ts, that binds one of READ_SYMBOLS from a module under
// src/core/ (a name, wherever it is re-exported from: `db/events` re-exports
// the event-queries and event-aggregates functions), or that pulls in
// READ_MODULES at all. `import type` is skipped: it is gone after
// compilation and moves nothing onto the main thread. (`import('…').Type`
// in a type position is the same: erased.) A runtime dynamic `import('…')` of a
// read module cannot name what it takes; there are none today and the last
// test fails on the first one, so it gets a decision instead of a silent pass.
//
// The unit is "file: symbol", not a line number, so editing a file does not
// move the baseline. The comparison is both ways: a new entry fails, and so
// does an entry that is no longer imported — a stale allowlist hides the next
// regression. To lower it, delete the entry in the change that removes the
// import. A new import of one of these in the main process is the thing the
// spec exists to stop: it raises the baseline only with the reason in the PR.
//
// Blind spots, on purpose: `require()` of a name is not seen; a symbol
// reached through a namespace import (`import * as q`) is not seen unless the
// module is in READ_MODULES; `aggregateTargets` and `distinctHosts` are named
// because `db/event-aggregates` is only ever imported through the `db/events`
// re-export, which the module rule alone would never see.
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'
import { importGraph, type ImportEdge } from './helpers/import-graph'
import { repoRelative } from './helpers/repo-path'

const ROOT = path.join(__dirname, '..')

/** Spec 074 plan "模組邊界" / T012. The writers of the two derived indexes
 *  are listed by name: their readers (`searchCasts`, `bodySearchCoverage`)
 *  move with them, but the writes are what must end up in one process. */
const READ_SYMBOLS: readonly string[] = [
  'getReadonlyDB', 'openReadOnlyDB',
  'executeEventQuery', 'queryEvents', 'countEvents', 'spanEvents',
  'querySourceSessions', 'queryEventCausalChain', 'queryScreenshotPage', 'queryHttpFlowPage', 'queryEventsPage',
  'distinctAgentTypes', 'getLootCount', 'aggregateTargets', 'distinctHosts',
  // http-body-index writes
  'linkHttpBodyEvent', 'pruneHttpBodyIndex', 'pruneSavedFileIndex', 'searchHttpBodyEventIds',
  // cast-index writes
  'indexCast', 'backfillCastIndex', 'pruneCast'
]
const READ_MODULES: readonly string[] = ['src/core/db/activity-queries.ts', 'src/core/db/event-aggregates.ts']
const DYNAMIC_READ_MODULE = /\b(?:await\s+|=\s*|\.then\(\s*\(\)\s*=>\s*)import\(\s*['"]\.[^'"]*(?:db\/(?:activity-queries|event-aggregates|event-queries|events|index)|http-body-index|cast-index|source-sessions)['"]/

/** Counted 2026-11-13 on origin/main faf3d376: 23 entries in 8 files. */
const BASELINE: Record<string, readonly string[]> = {
  'src/core/api-server.ts': ['executeEventQuery', 'queryEvents'],
  'src/main/active-pivots.ts': ['queryEvents'],
  'src/main/index.ts': ['backfillCastIndex', 'getLootCount', 'queryEvents'],
  'src/main/ipc/artifacts.ts': ['queryEvents'],
  'src/main/ipc/data-export.ts': ['getReadonlyDB'],
  'src/main/ipc/events.ts': [
    'aggregateTargets', 'countEvents', 'distinctAgentTypes', 'distinctHosts', 'executeEventQuery', 'module activity-queries',
    'queryEventCausalChain', 'queryEvents', 'queryEventsPage', 'queryHttpFlowPage', 'queryScreenshotPage', 'querySourceSessions', 'spanEvents'
  ],
  'src/main/ipc/terminal.ts': ['backfillCastIndex'],
  'src/main/terminal-manager.ts': ['indexCast']
}

const inScope = (file: string): boolean => file.startsWith('src/main/') || file === 'src/core/api-server.ts'

/** Only the edges that can be told apart by what they bind, so a file that
 *  imports the same name twice (a type and a value) counts once. */
function offenders(edges: readonly ImportEdge[]): Record<string, string[]> {
  const found: Record<string, Set<string>> = {}
  const add = (file: string, entry: string): void => { (found[file] ??= new Set()).add(entry) }
  for (const e of edges) {
    if (!inScope(e.from) || e.typeOnly || !e.to?.startsWith('src/core/')) continue
    for (const name of e.names) if (READ_SYMBOLS.includes(name)) add(e.from, name)
    if (READ_MODULES.includes(e.to)) add(e.from, `module ${path.posix.basename(e.to, '.ts')}`)
  }
  return Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)).map(([f, s]) => [f, [...s].sort()]))
}

const edges = importGraph(ROOT)

describe('the main process and the API server import the read side only as far as today', () => {
  it('scans the files it means to (a guard against an empty scan passing)', () => {
    const files = glob.sync(['src/main/**/*.{ts,tsx}', 'src/core/api-server.ts'], { cwd: ROOT }).map((f) => repoRelative(ROOT, path.join(ROOT, f)))
    expect(files).toContain('src/core/api-server.ts')
    expect(files).toContain('src/main/ipc/events.ts')
    expect(edges.some((e) => e.from === 'src/main/ipc/events.ts' && e.to === 'src/core/db/events.ts')).toBe(true)
  })

  it('imports no more of them than the baseline, and no entry has gone stale (ratchet: only shrinks)', () => {
    const now = offenders(edges)
    const list = (o: Record<string, readonly string[]>): string => Object.entries(o).map(([f, s]) => `${f}: ${s.join(', ')}`).join('\n')
    const added = Object.entries(now).flatMap(([f, s]) => s.filter((n) => !BASELINE[f]?.includes(n)).map((n) => `${f}: ${n}`))
    const stale = Object.entries(BASELINE).flatMap(([f, s]) => s.filter((n) => !now[f]?.includes(n)).map((n) => `${f}: ${n}`))
    expect(added, `new read-side imports in the main process:\n${added.join('\n')}\n\nall of them today:\n${list(now)}`).toEqual([])
    expect(stale, `baseline entries that are no longer imported (delete them):\n${stale.join('\n')}`).toEqual([])
  })

  it('has no runtime dynamic import of a read module, which the import graph cannot attribute', () => {
    const files = glob.sync(['src/main/**/*.{ts,tsx}', 'src/core/api-server.ts'], { cwd: ROOT })
    const hits = files.flatMap((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/)
      .flatMap((line, i) => (DYNAMIC_READ_MODULE.test(line) ? [`${repoRelative(ROOT, path.join(ROOT, f))}:${i + 1}`] : [])))
    expect(hits).toEqual([])
  })

  it('tells a runtime dynamic import from a type-position one', () => {
    expect(DYNAMIC_READ_MODULE.test("const m = await import('../../core/db/events')")).toBe(true)
    expect(DYNAMIC_READ_MODULE.test("const m = await import('../../core/http-body-index')")).toBe(true)
    expect(DYNAMIC_READ_MODULE.test("ipcMain.handle('x', (_e, o: import('../../core/db/events').Opts) => 1)")).toBe(false)
  })
})
