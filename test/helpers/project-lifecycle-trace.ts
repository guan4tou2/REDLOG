// Runs main's own `startProject`, `startProjectResources` and `stopProject`
// with every outside name replaced by a recording double, and returns what they
// called, in order. Spec 073 T004.
//
// src/main/index.ts is the Electron entry point and cannot be imported by a
// test. Its three lifecycle functions are, however, plain functions that only
// reach for module-level names and imports. So this reads them out of the
// source with the TypeScript AST, transpiles them, and runs them inside a
// `with (scope)` block whose scope answers every free name with a double. What
// is traced is therefore the code that ships, not a copy of it: change the
// order of two lines in index.ts and the trace changes.
//
// What the doubles do:
//   - a name not in NATIVES is a callable Proxy; calling it records
//     `name(args)`; reading a property gives another double named `a.b`; the
//     result of a call is a double named `a.b()`. A double coerces to NaN, so
//     `count > 0` is false and a branch on a result is not taken.
//   - OVERRIDES give a double a real answer where a branch needs one (is a
//     project open, what config was read). Everything else is the default.
//   - `configApplier.apply` is replaced by a driver over the real
//     OPEN_SEQUENCE: it records each step, and runs each hook (the closures
//     startProjectResources hands it), so the hooks' own calls appear where
//     the sequence puts them. What a step does is pinned by config-apply.test.ts.
//   - timers are doubles too (`clearTimeout(...)` is a recorded step, nothing
//     is scheduled).
// Not recorded: property reads, `new Map()` and friends, console output, and
// everything inside a callback main hands to a double (it is never called).
//
// Pinned values contain no path, time, platform or locale: `process.platform`
// is supplied, `Date.now()` is not recorded, and arguments are printed as JSON
// or as the name of the double they are.
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { OPEN_SEQUENCE } from '../../src/core/config-apply-plan'
import { DEFAULT_CONFIG } from '../../src/core/config'

const INDEX = path.join(__dirname, '..', '..', 'src', 'main', 'index.ts')
const FUNCTIONS = ['startProject', 'startProjectResources', 'stopProject']

/** Names that stay what they are. Anything else free in the three functions is a double. */
const NATIVES = new Set([
  'Object', 'Array', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Date', 'JSON', 'Math', 'Number', 'String', 'Boolean',
  'Error', 'TypeError', 'RangeError', 'RegExp', 'Symbol', 'undefined', 'NaN', 'Infinity', 'parseInt', 'parseFloat', 'isNaN',
  'globalThis', 'Reflect', 'Proxy', 'BigInt', 'Buffer', 'Uint8Array', 'Intl', 'AbortController'
])

type Overrides = Record<string, (...args: unknown[]) => unknown>

export interface Trace {
  calls: string[]
}

const DOUBLE = Symbol('double')

function show(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'function') return (value as { [DOUBLE]?: string })[DOUBLE] ? `<${(value as { [DOUBLE]?: string })[DOUBLE]}>` : 'ƒ'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(show).join(',')}]`
  if (typeof value === 'object') return `{${Object.keys(value as object).join(',')}}`
  return String(value)
}

function functionSources(): string {
  const text = fs.readFileSync(INDEX, 'utf8')
  const sf = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true)
  const found = new Map<string, string>()
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name && FUNCTIONS.includes(s.name.text)) found.set(s.name.text, text.slice(s.getFullStart(), s.getEnd()))
  }
  for (const name of FUNCTIONS) if (!found.has(name)) throw new Error(`src/main/index.ts no longer has a top-level function ${name}; update test/helpers/project-lifecycle-trace.ts`)
  return FUNCTIONS.map((n) => found.get(n)).join('\n')
}

function transpile(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, alwaysStrict: false, removeComments: true }
  }).outputText
}

export interface Harness {
  trace: Trace
  startProject(project: { id: string }): void
  stopProject(): void
  /** The value main's module-level `let` currently holds, as the doubles see it. */
  set(name: string, value: unknown): void
}

/** `initial` seeds main's module-level `let`s; the string '@double' means "a recording double named after it".
 *  `platform` is what `process.platform` reads inside the functions. */
export function makeHarness(opts: { platform: string; overrides?: Overrides; initial?: Record<string, unknown> }): Harness {
  const calls: string[] = []
  const values = new Map<string, unknown>(Object.entries(opts.initial ?? {}))
  const overrides: Overrides = {
    // A project is open only when a test says so.
    'projectRuntime.current': () => null,
    prepareOpenConfig: () => DEFAULT_CONFIG,
    '*.isDestroyed': () => false,
    '*.isVisible': () => true,
    getProjectPath: () => 'PROJECT_DIR',
    ...opts.overrides
  }
  const cache = new Map<string, unknown>()

  function double(name: string): unknown {
    const hit = cache.get(name)
    if (hit) return hit
    const target = function () { /* callable shell */ } as unknown as { [DOUBLE]: string }
    target[DOUBLE] = name
    const proxy: unknown = new Proxy(target, {
      apply: (_t, _this, args) => {
        calls.push(`${name}(${args.map(show).join(', ')})`)
        const o = overrides[name]
        return o ? o(...args) : double(`${name}()`)
      },
      construct: (_t, args) => {
        calls.push(`new ${name}(${args.map(show).join(', ')})`)
        return double(`new ${name}`)
      },
      get: (t, prop) => {
        if (prop === DOUBLE) return name
        if (typeof prop === 'symbol') return undefined
        if (prop === 'valueOf') return () => NaN
        if (prop === 'toString') return () => name
        const dotted = `${name}.${prop}`
        if (dotted in overrides) return makeOverride(dotted)
        // `*.isVisible` answers for any object, e.g. the window createOverlayWindow() returned.
        if (`*.${prop}` in overrides) return makeOverride(`*.${prop}`, dotted)
        void t
        return double(dotted)
      },
      set: () => true
    })
    cache.set(name, proxy)
    return proxy
  }

  function makeOverride(key: string, label = key): unknown {
    const o = overrides[key]
    const fn = function () { /* shell */ } as unknown as { [DOUBLE]: string }
    fn[DOUBLE] = label
    return new Proxy(fn, { apply: (_t, _this, args) => { calls.push(`${label}(${args.map(show).join(', ')})`); return o(...args) } })
  }

  const driven: Record<string, unknown> = {
    process: { platform: opts.platform },
    console: { log: () => undefined, error: () => undefined, warn: () => undefined },
    testHooks: { e2e: false, hideHud: false }
  }
  // The real order of an open; hooks run where the sequence puts them.
  overrides['configApplier.apply'] = (arg: unknown) => {
    const { hooks } = arg as { hooks: Record<string, () => void> }
    for (const entry of OPEN_SEQUENCE) {
      if ('step' in entry) calls.push(`  apply.step ${entry.step}`)
      else { calls.push(`  apply.hook ${entry.hook} {`); hooks[entry.hook](); calls.push(`  } ${entry.hook}`) }
    }
  }
  overrides['setTimeout'] = () => undefined

  const scope = new Proxy({}, {
    has: (_t, name) => typeof name === 'string' && name !== '__scope' && !NATIVES.has(name),
    get: (_t, name) => {
      if (typeof name === 'symbol') return undefined
      if (values.has(name)) { const v = values.get(name); return v === '@double' ? double(name) : v }
      if (name in driven && driven[name] !== undefined) return driven[name]
      return double(name)
    },
    set: (_t, name, value) => { if (typeof name === 'string') values.set(name, value); return true }
  })

  const body = `with (__scope) {\n${transpile(functionSources())}\nreturn { startProject, stopProject }\n}`
  const fns = new Function('__scope', body)(scope) as { startProject: (p: unknown) => void; stopProject: () => void }
  return {
    trace: { calls },
    startProject: (p) => fns.startProject(p),
    stopProject: () => fns.stopProject(),
    set: (name, value) => { values.set(name, value) }
  }
}

/** How many `clean(...)` steps stopProject has, read from the source. */
export function countCleanSteps(): number {
  const sf = ts.createSourceFile('index.ts', fs.readFileSync(INDEX, 'utf8'), ts.ScriptTarget.Latest, true)
  let n = 0
  for (const s of sf.statements) {
    if (!(ts.isFunctionDeclaration(s) && s.name?.text === 'stopProject')) continue
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'clean' && node.arguments.length === 1) n++
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(s, visit)
  }
  return n
}
