// CLAUDE.md §React: never declare a component inside another component's
// body. A function defined there is a new component type on every render, so
// React unmounts and remounts its whole subtree each time: focus and state are
// lost on the keystroke that caused the render, Fast Refresh renders part of
// the panel and stops, and no unit test sees it because a test renders once.
// ExportMenu shipped three of them with a green suite; StatusBar had `Sep`.
//
// There is no ESLint here (react/no-unstable-nested-components would be the
// real rule), so this is a ratchet over the TypeScript AST, pinned at the
// current count. To lower it: move the component to module scope and pass what
// it closed over as props, then lower INLINE_COMPONENT_BASELINE.
//
// What it finds: inside the body of a component (a capitalised function, or a
// capitalised const bound to an arrow/function, optionally wrapped in a call
// such as memo/forwardRef) or a hook (useXxx), at any depth, a capitalised
// function declaration or a capitalised const bound to an arrow/function (or
// a call wrapping one) whose body contains JSX.
//
// What it does not find (blind spots):
//   - a component bound to a lowercase name and rendered through a capitalised
//     alias later, or created by React.createElement without JSX;
//   - components built by a factory (`const Row = makeRow(x)`) or stored in an
//     object or array (`{ Row: () => <div/> }`, `cells.map(...)`);
//   - class components, and anything in a .ts file (no JSX parses there);
//   - a capitalised `let` reassigned later, or a component memoised with
//     useMemo/useCallback — these are still new types when their deps change;
//   - components declared in a lowercase non-hook helper that is itself called
//     during render.
// A lowercase render helper called as a function (`renderRow()`) is not a
// component type and is correctly not counted.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import glob from 'fast-glob'
import { repoRelative } from './helpers/repo-path'

const ROOT = path.join(__dirname, '..')

// Counted 2026-11-12 after StatusBar's `Sep` moved to module scope.
const INLINE_COMPONENT_BASELINE = 0

const isComponentName = (n: string): boolean => /^[A-Z]/.test(n)
const isOuterName = (n: string): boolean => isComponentName(n) || /^use[A-Z]/.test(n)

/** The function a declaration binds, looking through one call wrapper (memo, forwardRef). */
function boundFunction(init: ts.Expression | undefined): ts.FunctionLikeDeclaration | null {
  if (!init) return null
  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init
  if (ts.isCallExpression(init)) {
    const arg = init.arguments[0]
    if (arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) return arg
  }
  return null
}

function containsJsx(node: ts.Node): boolean {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) { found = true; return }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}

/** Named functions inside `body` that are components by the rule above. */
function nestedComponents(body: ts.Node, sf: ts.SourceFile): string[] {
  const out: string[] = []
  const visit = (n: ts.Node): void => {
    let name: string | null = null
    let fn: ts.FunctionLikeDeclaration | null = null
    if (ts.isFunctionDeclaration(n) && n.name) { name = n.name.text; fn = n }
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) { name = n.name.text; fn = boundFunction(n.initializer) }
    if (name && fn?.body && isComponentName(name) && containsJsx(fn.body)) {
      out.push(`${name}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`)
    }
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(body, visit)
  return out
}

function findInlineComponents(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []
  const outer = (name: string, fn: ts.FunctionLikeDeclaration | null): void => {
    if (fn?.body && isOuterName(name)) found.push(...nestedComponents(fn.body, sf).map((c) => `${file}: ${c} inside ${name}`))
  }
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st)) outer(st.name?.text ?? 'default', st)
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) outer(d.name.text, boundFunction(d.initializer))
    }
  }
  return found
}

describe('components declared inside components', () => {
  it('the scan finds the shapes it claims to, and not a render helper', () => {
    const src = `
      export function Panel() { const Sep = () => <span/>; return <div><Sep/></div> }
      export const Menu = memo(function Menu() { function Item() { return <li/> } return <ul><Item/></ul> })
      export function useRows() { const Row = forwardRef(() => <tr/>); return Row }
      export function Clean() { const renderRow = () => <tr/>; const Label = 'x'; return <table>{renderRow()}{Label}</table> }
      function Sep2() { return <span/> }`
    expect(findInlineComponents('x.tsx', src)).toEqual([
      'x.tsx: Sep:2 inside Panel', 'x.tsx: Item:3 inside Menu', 'x.tsx: Row:4 inside useRows'
    ])
  })

  it('does not grow past the recorded baseline', () => {
    const found: string[] = []
    for (const file of glob.sync('src/renderer/src/**/*.tsx', { cwd: ROOT, absolute: true })) {
      found.push(...findInlineComponents(repoRelative(ROOT, file), fs.readFileSync(file, 'utf8')))
    }
    expect(found.length, `components declared inside a component or hook (baseline ${INLINE_COMPONENT_BASELINE}); ` +
      `move them to module scope and pass what they closed over:\n${found.join('\n')}`)
      .toBeLessThanOrEqual(INLINE_COMPONENT_BASELINE)
  })
})
