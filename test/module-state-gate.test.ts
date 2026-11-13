// Spec 073 T002. The module-state rule of `npm run verify:architecture`
// (scripts/module-state.mjs + scripts/module-state-allowlist.json) against
// synthetic sources, so the gate is shown able to fail, and against the real
// tree, so a stale list is also caught by `npm test`.
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import fs from 'fs'
import path from 'path'
import { scanModuleState, checkModuleState, MODULE_STATE_CLASSES } from '../scripts/module-state.mjs'

const ROOT = path.join(__dirname, '..')

function scan(source: string): Array<{ name: string; kind: string }> {
  const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  return scanModuleState(sf).map(({ name, kind }: { name: string; kind: string }) => ({ name, kind }))
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mts)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

function realFound(): Array<{ key: string; line: number; kind: string }> {
  const out: Array<{ key: string; line: number; kind: string }> = []
  for (const f of [...walk(path.join(ROOT, 'src/core')), ...walk(path.join(ROOT, 'src/main'))]) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/')
    const sf = ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, f.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    for (const d of scanModuleState(sf)) out.push({ key: `${rel}#${d.name}`, line: d.line, kind: d.kind })
  }
  return out
}

const entry = (cls: string) => ({ class: cls, reason: 'reason long enough' })

describe('module-state scanner', () => {
  it('sees let, var, new, array literals and create*() at the top level', () => {
    expect(scan(`
      let a = 1
      var b
      const c = new Map<string, number>()
      const d: string[] = []
      const e = createThing()
      const f = [] as string[]
    `)).toEqual([
      { name: 'a', kind: 'let/var' }, { name: 'b', kind: 'let/var' }, { name: 'c', kind: 'new' },
      { name: 'd', kind: 'array' }, { name: 'e', kind: 'create()' }, { name: 'f', kind: 'array' }
    ])
  })

  it('does not see plain constants, object literals, other calls, or anything below the top level', () => {
    expect(scan(`
      const s = 'x'
      const n = 3
      const o = { a: 1 }
      const fn = () => { let inner = 1; return inner }
      const w = makeThing()
      function g() { let local = new Map(); return local }
      class K { static cache = new Map() }
      if (true) { let blocked = 1 }
    `)).toEqual([])
  })
})

describe('module-state gate', () => {
  const found = [
    { key: 'src/core/a.ts#x', line: 1, kind: 'let/var' },
    { key: 'src/core/a.ts#y', line: 2, kind: 'new' }
  ]
  const good = { projectLegacyBaseline: 1, entries: { 'src/core/a.ts#x': entry('project-legacy'), 'src/core/a.ts#y': entry('app') } }

  it('passes a fully registered tree', () => {
    expect(checkModuleState(found, good)).toEqual({ problems: [], projectLegacy: 1 })
  })

  it('fails on an unregistered module-level let, naming file and line', () => {
    const r = checkModuleState([...found, { key: 'src/core/a.ts#fresh', line: 9, kind: 'let/var' }], good)
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toMatch(/src\/core\/a\.ts:9 .*"fresh" is not in scripts\/module-state-allowlist\.json/)
  })

  it('fails on a stale entry, an unknown class, a missing reason and a duplicate declaration', () => {
    expect(checkModuleState(found, { ...good, entries: { ...good.entries, 'src/core/gone.ts#z': entry('app') } }).problems.join('\n')).toMatch(/gone\.ts#z" no longer matches/)
    expect(checkModuleState(found, { ...good, entries: { ...good.entries, 'src/core/a.ts#y': entry('session-slot') } }).problems.join('\n')).toMatch(/"src\/core\/a\.ts#y" has class "session-slot"/)
    expect(checkModuleState(found, { ...good, entries: { ...good.entries, 'src/core/a.ts#y': { class: 'app', reason: '' } } }).problems.join('\n')).toMatch(/"src\/core\/a\.ts#y" needs a reason/)
    expect(checkModuleState([...found, found[0]], good).problems.join('\n')).toMatch(/declared twice/)
  })

  it('is a ratchet on project-legacy: one more fails, one fewer also fails until the baseline is lowered', () => {
    const more = { projectLegacyBaseline: 1, entries: { ...good.entries, 'src/core/a.ts#y': entry('project-legacy') } }
    expect(checkModuleState(found, more).problems.join('\n')).toMatch(/is 2, baseline 1/)
    const fewer = { projectLegacyBaseline: 1, entries: { ...good.entries, 'src/core/a.ts#x': entry('app') } }
    expect(checkModuleState(found, fewer).problems.join('\n')).toMatch(/is 0, below baseline 1/)
  })

  it('knows exactly the five classes of the plan', () => {
    expect([...MODULE_STATE_CLASSES]).toEqual(['app', 'machine', 'constant', 'test-seam', 'project-legacy'])
  })
})

describe('module state of today\'s src/core and src/main', () => {
  const allow = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'module-state-allowlist.json'), 'utf8'))

  it('every declaration is registered and every entry is live', () => {
    const r = checkModuleState(realFound(), allow)
    expect(r.problems).toEqual([])
  })

  it('project-legacy is pinned at the count measured when Phase 1 landed', () => {
    // 320 declarations: 87 constant, 66 app, 25 machine, 1 test-seam, 141
    // project-legacy. The ratchet only goes down; Phase 3 moves each into the
    // session. The class of an entry is a judgement made when it was
    // registered — read its reason before relying on it.
    const counts: Record<string, number> = {}
    for (const e of Object.values(allow.entries) as Array<{ class: string }>) counts[e.class] = (counts[e.class] ?? 0) + 1
    expect(counts['project-legacy']).toBe(allow.projectLegacyBaseline)
    expect(allow.projectLegacyBaseline).toBe(141)
  })
})
