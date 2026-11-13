// A small import graph over src/**, for tests that count who depends on what.
//
// It reads the text, not the type checker: an import is a `from '<rel>'`, an
// `import('<rel>')` or a `require('<rel>')` whose specifier starts with `.`,
// resolved against the importing file to a file under src/. Comment lines are
// skipped. Names are the identifiers a statement binds from that module
// (`{ a, b as c }` gives a and b; a default or namespace import gives
// `default` / `*`). Only relative specifiers are followed: nothing in src/
// reaches another src/ file any other way.
import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'
import { repoRelative } from './repo-path'

export interface ImportEdge {
  /** Importing file, repo-relative. */
  from: string
  /** Imported file, repo-relative; null when the specifier did not resolve. */
  to: string | null
  /** 1-based line the statement starts on. */
  line: number
  /** Identifiers the statement binds from the module. */
  names: string[]
  /** `import type { … }` / `export type { … }`: gone after compilation. */
  typeOnly: boolean
}

const EXT = ['.ts', '.tsx', '.js', '.mjs', '.cjs']

function stripComments(src: string): string {
  // Blank, not delete, so line numbers survive.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => (l.trim().startsWith('//') ? '' : l))
    .join('\n')
}

function resolve(root: string, fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(path.join(root, fromFile)), spec)
  const candidates = [base, ...EXT.map((e) => base + e), ...EXT.map((e) => path.join(base, 'index' + e))]
  // `./x.js` in a .ts file names ./x.ts.
  if (/\.(js|mjs|cjs)$/.test(base)) candidates.push(base.replace(/\.(js|mjs|cjs)$/, '.ts'), base.replace(/\.(js|mjs|cjs)$/, '.tsx'))
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return repoRelative(root, c)
  }
  return null
}

function namesOf(clause: string): string[] {
  const out: string[] = []
  const braces = clause.match(/\{([\s\S]*?)\}/)
  if (braces) {
    for (const part of braces[1].split(',')) {
      const n = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
      if (n) out.push(n)
    }
  }
  const rest = clause.replace(/\{[\s\S]*?\}/, '').replace(/^type\s+/, '').trim()
  if (/\*\s+as\s+\w+/.test(rest)) out.push('*')
  else if (/^\w+\s*,?$/.test(rest) && rest) out.push('default')
  return out
}

function allTypeNames(clause: string): boolean {
  const braces = clause.match(/\{([\s\S]*?)\}/)
  if (!braces || clause.replace(/\{[\s\S]*?\}/, '').trim()) return false
  const parts = braces[1].split(',').map((p) => p.trim()).filter(Boolean)
  return parts.length > 0 && parts.every((p) => /^type\s+/.test(p))
}

// The clause may not contain `from`, a quote or another `import`, so a match
// cannot start at one statement and run into the next.
const STATIC = /\b(import|export)\s+(type\s+)?((?:(?!\bfrom\b|\bimport\b|['"`;])[\s\S])*?)\s+from\s+['"](\.[^'"]*)['"]/g
const BARE = /\bimport\s+['"](\.[^'"]*)['"]/g
const DYNAMIC = /\b(?:import|require)\(\s*['"](\.[^'"]*)['"]\s*\)/g

/** Every relative import in src/**. */
export function importGraph(root: string): ImportEdge[] {
  const edges: ImportEdge[] = []
  for (const abs of glob.sync('src/**/*.{ts,tsx}', { cwd: root, absolute: true })) {
    const from = repoRelative(root, abs)
    const text = stripComments(fs.readFileSync(abs, 'utf8'))
    const lineAt = (idx: number): number => text.slice(0, idx).split('\n').length
    for (const m of text.matchAll(STATIC)) {
      const clause = m[3]
      edges.push({ from, to: resolve(root, from, m[4]), line: lineAt(m.index ?? 0), names: namesOf(clause), typeOnly: !!m[2] || allTypeNames(clause) })
    }
    for (const m of text.matchAll(BARE)) edges.push({ from, to: resolve(root, from, m[1]), line: lineAt(m.index ?? 0), names: [], typeOnly: false })
    for (const m of text.matchAll(DYNAMIC)) edges.push({ from, to: resolve(root, from, m[1]), line: lineAt(m.index ?? 0), names: [], typeOnly: false })
  }
  return edges
}
