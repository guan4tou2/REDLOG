// Spec 073 T003 (FR-012, FR-091). A ratchet over the calls that read a
// project's config.yaml from disk by calling core `loadConfig(` themselves.
// Every one of them can see a value that differs from what the open project
// is running with, which is how air-gap came to apply by halves. Spec 073
// replaces them with a ConfigView read from the session; ConfigStore (the one
// writer) and config.ts itself are the only places allowed to read the file.
//
// Counted by the TypeScript AST over src/: a call to the function imported as
// `loadConfig` from the core config module (or `x.loadConfig(...)` on its
// namespace), outside src/core/config.ts and src/main/config-store.ts. The
// renderer's own `loadConfig` helpers in Settings.tsx and DashboardView.tsx
// are local functions that fetch through IPC; they are not file reads and are
// not counted (a plain text search for `loadConfig(` counts them, which is why
// that search says 35 and this test says 33).
//
// The plan's table and task text say 36. That number was counted against an
// older main; the list below is what is there today.
//
// To lower it: route a read through the session's config, then set BASELINE to
// the new count. It may not go up.
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import fs from 'fs'
import path from 'path'

const ROOT = path.join(__dirname, '..')
const ALLOWED = new Set(['src/core/config.ts', 'src/main/config-store.ts'])
const BASELINE = 33

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mts)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** `file:line` of each call that reads the project config file, in `source`. */
function directReads(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const locals = new Set<string>()
  const namespaces = new Set<string>()
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue
    if (!/(^|\/)config(\.js)?$/.test(s.moduleSpecifier.text)) continue
    const b = s.importClause?.namedBindings
    if (!b) continue
    if (ts.isNamespaceImport(b)) namespaces.add(b.name.text)
    else for (const el of b.elements) if ((el.propertyName ?? el.name).text === 'loadConfig') locals.add(el.name.text)
  }
  const hits: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const c = n.expression
      const direct = ts.isIdentifier(c) && locals.has(c.text)
      const viaNs = ts.isPropertyAccessExpression(c) && c.name.text === 'loadConfig' && ts.isIdentifier(c.expression) && namespaces.has(c.expression.text)
      if (direct || viaNs) hits.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return hits
}

function today(): string[] {
  const hits: string[] = []
  for (const f of walk(path.join(ROOT, 'src'))) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/')
    if (ALLOWED.has(rel)) continue
    hits.push(...directReads(rel, fs.readFileSync(f, 'utf8')))
  }
  return hits
}

describe('direct reads of the project config file', () => {
  it('counts the call forms it claims to count (so a rename cannot hide a read)', () => {
    expect(directReads('a.ts', `import { loadConfig } from './config'\nloadConfig(d)\nconst f = () => loadConfig(d).x`)).toEqual(['a.ts:2', 'a.ts:3'])
    expect(directReads('b.ts', `import { loadConfig as lc } from '../core/config'\nlc(d)`)).toEqual(['b.ts:2'])
    expect(directReads('c.ts', `import * as cfg from '../core/config'\ncfg.loadConfig(d)`)).toEqual(['c.ts:2'])
    expect(directReads('d.ts', `const loadConfig = () => 1\nloadConfig()`)).toEqual([])
    expect(directReads('e.ts', `import { loadConfig } from './other'\nloadConfig(d)`)).toEqual([])
  })

  it(`there are ${BASELINE} direct reads outside config.ts and config-store.ts, and the number only goes down`, () => {
    const hits = today()
    const where = `\n${hits.join('\n')}\n`
    if (hits.length > BASELINE) {
      throw new Error(`${hits.length} direct loadConfig( reads, baseline ${BASELINE}. A new one reads the file instead of the session's config; take it from the session. Current list:${where}`)
    }
    if (hits.length < BASELINE) {
      throw new Error(`${hits.length} direct loadConfig( reads, below baseline ${BASELINE}: lower BASELINE to ${hits.length} in this change. Current list:${where}`)
    }
    expect(hits).toHaveLength(BASELINE)
  })
})
