// Spec 072 T006 (and FR-022 later): which src/core files a renderer file drags
// in at run time, and which of those import something only Node has.
//
// A walk over real imports, not text: `import type …`, `import { type X }` and
// `export type … from` are erased by the compiler and do not count; a bare
// `import './x'`, a value import, a dynamic `import('./x')` and a `require` do.
// Only relative specifiers are followed (the renderer reaches core with
// `../../../core/…`; there is no path alias).
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { builtinModules } from 'node:module'

const NODE = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]))
const EXTS = ['.ts', '.tsx', '/index.ts', '/index.tsx', '.js']

function resolve(from: string, spec: string): string | null {
  const base = path.resolve(path.dirname(from), spec)
  for (const e of ['', ...EXTS]) {
    const f = base + e
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return f
  }
  return null
}

export interface Edge { spec: string; type: boolean }

/** Every import-ish specifier in a file and whether the compiler erases it. */
export function importsOf(file: string): Edge[] {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const out: Edge[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const c = n.importClause
      const named = c?.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements : null
      const erased = !!c && (c.isTypeOnly || (!c.name && !!named && named.length > 0 && named.every((e) => e.isTypeOnly)))
      out.push({ spec: n.moduleSpecifier.text, type: erased })
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const named = n.exportClause && ts.isNamedExports(n.exportClause) ? n.exportClause.elements : null
      out.push({ spec: n.moduleSpecifier.text, type: n.isTypeOnly || (!!named && named.length > 0 && named.every((e) => e.isTypeOnly)) })
    } else if (ts.isCallExpression(n) && n.arguments.length === 1 && ts.isStringLiteralLike(n.arguments[0])
      && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) {
      out.push({ spec: (n.arguments[0] as ts.StringLiteral).text, type: false })
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** Files under `roots` reached from `entries` through non-type relative imports, with the chain that reached each. */
export function reach(entries: string[]): Map<string, string[]> {
  const seen = new Map<string, string[]>()
  const queue: Array<[string, string[]]> = entries.map((e) => [e, [e]])
  while (queue.length) {
    const [file, chain] = queue.shift()!
    if (seen.has(file)) continue
    seen.set(file, chain)
    for (const edge of importsOf(file)) {
      if (edge.type || !edge.spec.startsWith('.')) continue
      const next = resolve(file, edge.spec)
      if (next && /\.(ts|tsx)$/.test(next) && !seen.has(next)) queue.push([next, [...chain, next]])
    }
  }
  return seen
}

/** The Node modules a file imports at run time. */
export function nodeImportsOf(file: string): string[] {
  return importsOf(file).filter((e) => !e.type && NODE.has(e.spec)).map((e) => e.spec).sort()
}
