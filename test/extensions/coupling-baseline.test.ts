// Spec 076 T005 (FR-020, FR-022, plan "耦合證據"): the coupling table as a test.
//
// FR-022 lets code move out of main only when four things hold; two of them are
// about imports: (a) the extension imports no write primitive but the door
// (`configureIngest`, `getDB`, `insertEvent`, `ingestEvent`), and (b) nothing in
// the base layer reads its state. The plan's table says what each candidate
// imports and who imports it today. This test holds the table.
//
// For each row it measures, from the text of src/**:
//   importers   the files outside the row that import one of its modules
//   primitives  which of the four write primitives its own modules import
//   from where  the file each primitive is imported from
// and compares them with the lists below, which are what main says today
// (2026-11-13, origin/main 875092a6). Both directions fail:
//   - a NEW importer or primitive is a coupling that was not there. The test
//     prints it. It is either removed, or it is recorded here with the reason
//     in the same change, which is a decision, not a drift.
//   - an entry that is no longer true is a stale baseline. The test says to
//     delete it, so the list only ever shrinks and a freed edge cannot grow back
//     unseen.
// `builtin-terminal` literals are counted the same way (they are the base
// layer's knowledge of one extension: 071 FR-012 takes them to 0).
//
// What it cannot see: a call through a variable, `require` of a computed path,
// and `ipcMain` channel names. The AI adapters are loaded by path at run time
// (agent-tailer.ts), so `optional-plugins/**` has no edge here; that is the
// point of the "AI tool capture" row's note, not a gap in the scan.
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'
import { importGraph, type ImportEdge } from '../helpers/import-graph'
import { repoRelative } from '../helpers/repo-path'

const ROOT = path.join(__dirname, '..', '..')
const PRIMITIVES = ['configureIngest', 'getDB', 'insertEvent', 'ingestEvent']

interface Row {
  id: string
  /** Files that are the extension's own code inside src/. */
  modules: string[]
  /** Files outside `modules` that import one of them; ` (type)` when every edge is type-only. */
  importers: string[]
  /** `<module> imports <primitive> from <file>`. */
  primitives: string[]
}

const ROWS: Row[] = [
  {
    id: 'capture-browser (cdp-connector)',
    modules: ['src/main/services/cdp-connector.ts'],
    importers: ['src/main/index.ts'],
    primitives: ['src/main/services/cdp-connector.ts imports ingestEvent from src/core/ingest.ts']
  },
  {
    id: 'managed-http-proxy',
    modules: ['src/main/services/managed-http-proxy.ts'],
    importers: ['src/core/http-autostart.ts (type)', 'src/main/index.ts'],
    primitives: []
  },
  {
    id: 'builtin-terminal',
    modules: ['src/main/terminal-manager.ts'],
    importers: ['src/main/index.ts', 'src/main/ipc/terminal.ts'],
    primitives: [
      'src/main/terminal-manager.ts imports configureIngest from src/core/ingest.ts',
      'src/main/terminal-manager.ts imports getDB from src/core/db/index.ts',
      'src/main/terminal-manager.ts imports ingestEvent from src/core/ingest.ts'
    ]
  },
  {
    id: 'host-monitors (process, connection, file)',
    modules: ['src/main/services/process-monitor.ts', 'src/main/services/connection-monitor.ts', 'src/main/services/file-watcher.ts'],
    importers: ['src/main/index.ts'],
    primitives: [
      'src/main/services/connection-monitor.ts imports ingestEvent from src/core/ingest.ts',
      'src/main/services/file-watcher.ts imports ingestEvent from src/core/ingest.ts',
      'src/main/services/process-monitor.ts imports ingestEvent from src/core/ingest.ts'
    ]
  },
  {
    // The base layer's dependency on the monitors: core/ingest.ts imports the
    // socket table the monitors also feed (FR-022 (b); 13 号 U4 removes it).
    id: 'socket-attribution (what the monitors feed)',
    modules: ['src/core/socket-attribution.ts'],
    importers: [
      'src/core/ingest.ts',
      'src/main/ipc/events.ts',
      'src/main/services/connection-monitor.ts',
      'src/main/services/process-monitor.ts'
    ],
    primitives: []
  },
  {
    id: 'ai-tool-capture (agent-tailer + tailer-host)',
    modules: ['src/main/services/agent-tailer.ts', 'src/main/services/tailer-host.ts'],
    importers: ['src/main/index.ts'],
    primitives: [
      'src/main/services/tailer-host.ts imports getDB from src/core/db/index.ts',
      'src/main/services/tailer-host.ts imports ingestEvent from src/core/ingest.ts'
    ]
  }
]

/** `builtin-terminal` occurrences in src/core and src/main, comments included
 *  (Spec 076 FR-022 counts 32 and so does this). */
const BUILTIN_TERMINAL_BASELINE = 32

const graph = importGraph(ROOT)

function measure(row: Row): { importers: string[]; primitives: string[] } {
  const own = new Set(row.modules)
  const byImporter = new Map<string, ImportEdge[]>()
  for (const e of graph) {
    if (!e.to || !own.has(e.to) || own.has(e.from)) continue
    byImporter.set(e.from, [...(byImporter.get(e.from) ?? []), e])
  }
  const importers = [...byImporter].map(([from, edges]) => (edges.every((e) => e.typeOnly) ? `${from} (type)` : from)).sort()
  const primitives = graph
    .filter((e) => own.has(e.from) && !e.typeOnly)
    .flatMap((e) => e.names.filter((n) => PRIMITIVES.includes(n)).map((n) => `${e.from} imports ${n} from ${e.to}`))
    .sort()
  return { importers, primitives }
}

/** What differs between the two lists, in the words a reviewer needs. */
function diff(kind: string, now: string[], baseline: string[]): string[] {
  return [
    ...now.filter((x) => !baseline.includes(x)).map((x) => `NEW ${kind}: ${x}  (remove it, or record it in ROWS with the reason)`),
    ...baseline.filter((x) => !now.includes(x)).map((x) => `STALE ${kind}: ${x}  (no longer true: delete it from ROWS)`)
  ]
}

describe('coupling baseline (Spec 076 FR-022): who imports an extension, and what write primitives it imports', () => {
  it('the scan resolves every relative import under src/', () => {
    // An unresolved specifier is an edge the scan lost; zero today.
    const lost = graph.filter((e) => e.to === null).map((e) => `${e.from}:${e.line}`)
    expect(lost, lost.join('\n')).toEqual([])
  })

  it('every module a row names exists', () => {
    const missing = ROWS.flatMap((r) => r.modules).filter((m) => !fs.existsSync(path.join(ROOT, m)))
    expect(missing).toEqual([])
  })

  for (const row of ROWS) {
    it(`${row.id}: importers and primitives are the recorded ones`, () => {
      const now = measure(row)
      const problems = [...diff('importer', now.importers, row.importers), ...diff('primitive', now.primitives, row.primitives)]
      expect(problems, problems.join('\n')).toEqual([])
    })
  }

  it('`builtin-terminal` appears exactly as often in src/core and src/main as the base layer knows it today', () => {
    const found: string[] = []
    for (const file of glob.sync('src/{core,main}/**/*.{ts,tsx}', { cwd: ROOT, absolute: true })) {
      const rel = repoRelative(ROOT, file)
      fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
        for (const _ of line.matchAll(/builtin-terminal/g)) found.push(`${rel}:${i + 1}`)
      })
    }
    const verdict = found.length > BUILTIN_TERMINAL_BASELINE ? 'grew: remove the new literal'
      : found.length < BUILTIN_TERMINAL_BASELINE ? `stale: lower BUILTIN_TERMINAL_BASELINE to ${found.length}` : 'as recorded'
    expect(verdict, `${found.length} literals (baseline ${BUILTIN_TERMINAL_BASELINE}):\n${found.join('\n')}`).toBe('as recorded')
  })

  // The two rows outside src/: nothing imports their code, and their code
  // imports nothing of RedLog's. They talk to the door over HTTP, which is why
  // the plan says "不需搬".
  describe('pcap-capture and c2-tailers are out-of-process', () => {
    const DIRS = ['plugins/pcap-capture', 'plugins/c2-tailers']

    it('no file under src/ imports them', () => {
      const edges = graph.filter((e) => e.to && DIRS.some((d) => e.to!.startsWith(`${d}/`))).map((e) => `${e.from}:${e.line} -> ${e.to}`)
      expect(edges, edges.join('\n')).toEqual([])
    })

    it('they require only Node built-ins and their own files, and name none of the write primitives', () => {
      const offenders: string[] = []
      for (const dir of DIRS) {
        for (const file of glob.sync(`${dir}/**/*.js`, { cwd: ROOT })) {
          const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
          for (const m of text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
            const spec = m[1]
            if (spec.startsWith('./') && !spec.includes('..')) continue
            if (/^(node:)?(fs|path|os|crypto|http|https|net|readline|child_process|stream|util|events|url)$/.test(spec)) continue
            offenders.push(`${file}: require('${spec}')`)
          }
          text.split(/\r?\n/).forEach((line, i) => {
            if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
            for (const p of PRIMITIVES) if (new RegExp(`\\b${p}\\b`).test(line)) offenders.push(`${file}:${i + 1}: ${p}`)
          })
        }
      }
      expect(offenders, offenders.join('\n')).toEqual([])
    })
  })
})
