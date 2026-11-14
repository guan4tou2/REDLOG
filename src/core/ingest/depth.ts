// How deep a row's `data` may nest (Spec 071 FR-097).
//
// Both verifiers walk `data` recursively to rebuild a row's hash. Python's
// stops at its recursion limit, and a row nested past it reads there as CHAIN
// BROKEN although nothing in it changed; SQLite's json_tree, which fills the
// search index on every insert, refuses JSON nested past 1000 levels, and so
// does the insert. A producer that can send `data` — a handoff file, an AI
// tool's input, an HTTP body the proxy parsed, RedLog's own code — decides how
// deep it is. So the writer bounds it, and does so without losing anything
// (complete capture, DECISIONS 2026-11-13 §12).
//
// Counting: `data` itself is depth 1; an array or object directly inside it is
// depth 2, and so on. Scalars, strings included, add no level.
//
// The rule (FR-097). Containers down to depth 63 stay as they are. At depth 64
// a container stays only if it holds no container and is not marker-shaped;
// any other container at depth 64 is replaced, where it stands, by the wrapper
// `{"_collapsed": "<its JSON text>"}`, the text byte for byte what
// JSON.stringify writes. Marker-shaped means an object whose only key is
// COLLAPSED_KEY and whose value is a string. A sender's own marker-shaped
// object at depth 64 is wrapped too, so after the bound EVERY marker-shaped
// object at depth 64 is the writer's, and restoreDataDepth needs nothing but
// the stored row: at depth 64, parse each wrapper's string and put the result
// in its place. A marker-shaped object shallower than 64 is the sender's and
// is never read as a wrapper. The stamp counts the wrappers
// (`_ingest.collapsed`).
//
// For a value JSON can express — what JSON.parse makes, which is all an
// outside door can send — stored `data` never nests deeper than 64. The rule
// walks the value as it is, not what `toJSON` makes of it, so an in-process
// value whose `toJSON` writes containers can store deeper: a Buffer at 64 is a
// leaf here and `{"type":"Buffer","data":[…]}` (65) in the row, and a `toJSON`
// that returns a deep value is stored at that value's depth. A container at 64
// that is wrapped is written by its `toJSON`, as JSON.stringify would; one
// whose `toJSON` never stops nesting (`toJSON() { return { self: this } }`)
// throws RangeError at JSON_TEXT_MAX_DEPTH. The bytes stay JSON.stringify's in
// every case (test/ingest-depth-bound.test.ts pins each).
//
// 64 against what is measured (2026-11-14; spec 071 plan.md D13): the deepest
// `data` any fixture or golden in this repository holds is 3; the deepest AI
// tool input across 323,816 local Claude Code and Codex tool calls is 5 (6 as
// `data.tool_input`); an HTTP JSON body the proxy parses sits at depth 3, so a
// body nested 61 levels is kept as it is (62 when its innermost container holds
// only scalars). The Python verifier fails to rebuild
// a row at 332 levels of arrays on Python 3.9 and 3.11 (497 on 3.12–3.15), the
// app's own verifier near 2,300, SQLite's json_tree at 1,001.
//
// Within the limit nothing is copied or changed: the same object is returned.

/** The deepest a container may sit in a row's `data`, `data` being depth 1. */
export const MAX_DATA_DEPTH = 64
/** The one key of the wrapper that holds a collapsed container's JSON text. */
export const COLLAPSED_KEY = '_collapsed'

/** Nesting, counted over a whole request body or spool file (its root is
 *  level 1), past which an outside door refuses the event before parsing it
 *  and records a capture gap (FR-097; ./nesting-ceiling.ts). */
export const EVENT_NESTING_CEILING = 100_000
/** The capture_gap and quarantine reason for that refusal, and the API's. */
export const NESTED_TOO_DEEP = 'nested-too-deep'

type Container = Record<string, unknown> | unknown[]

const isContainer = (v: unknown): v is Container => v !== null && typeof v === 'object'

/** An object whose only own enumerable key is COLLAPSED_KEY, holding a string. */
function isMarkerShaped(v: Container): boolean {
  if (Array.isArray(v)) return false
  const keys = Object.keys(v)
  return keys.length === 1 && keys[0] === COLLAPSED_KEY && typeof (v as Record<string, unknown>)[COLLAPSED_KEY] === 'string'
}

function holdsContainer(v: Container): boolean {
  for (const key of Array.isArray(v) ? v.keys() : Object.keys(v)) {
    if (isContainer((v as Record<string | number, unknown>)[key as string])) return true
  }
  return false
}

/** A shallow copy that JSON.stringify sees as it sees `node`: same prototype
 *  (so a `toJSON` there still applies), same own enumerable keys. */
function copyOf(node: Container): Container {
  if (Array.isArray(node)) return node.slice()
  const out = Object.create(Object.getPrototypeOf(node) as object | null) as Record<string, unknown>
  for (const k of Object.keys(node)) setOwn(out, k, node[k])
  return out
}

/** `obj[key] = value` as an own data property, never through a setter: an own
 *  `__proto__` key stays a key (`=` would set the prototype). */
function setOwn(obj: Container, key: string | number, value: unknown): void {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true })
}

/** Walk containers down to depth 63, letting `at64` decide each container at
 *  depth 64. Copies only along a path where something changed. At most 64
 *  frames of recursion. */
function walk(data: Record<string, unknown>, at64: (node: Container, key: string) => unknown): Record<string, unknown> {
  const visit = (node: Container, depth: number): Container => {
    let out: Container | null = null
    const keys = Array.isArray(node) ? null : Object.keys(node)
    const n = keys ? keys.length : (node as unknown[]).length
    for (let i = 0; i < n; i++) {
      const key = keys ? keys[i] : i
      const child = (node as Record<string | number, unknown>)[key]
      if (!isContainer(child)) continue
      const next = depth + 1 === MAX_DATA_DEPTH ? at64(child, String(key)) : visit(child, depth + 1)
      if (next === child) continue
      if (out === null) out = copyOf(node)
      setOwn(out, key, next)
    }
    return out ?? node
  }
  return visit(data, 1) as Record<string, unknown>
}

/**
 * `data` bounded by FR-097's rule (above), and how many wrappers it holds.
 * `data` itself is never changed; when nothing needs wrapping it is returned
 * as it is. The text of a wrapped container is written without recursion
 * (jsonText), so no input is deep enough to overflow the stack here. A cycle,
 * which JSON cannot hold, throws as JSON.stringify does.
 */
export function boundDataDepth(data: Record<string, unknown>): { data: Record<string, unknown>; collapsed: number } {
  let collapsed = 0
  const out = walk(data, (node, key) => {
    if (!holdsContainer(node) && !isMarkerShaped(node)) return node
    collapsed++
    return { [COLLAPSED_KEY]: jsonText(node, key) }
  })
  return { data: out, collapsed }
}

/**
 * The inverse, from a stored row's `data` alone: every marker-shaped object at
 * depth 64 is a wrapper the writer made, and is replaced by what JSON.parse
 * makes of its string. Shallower marker-shaped objects are the sender's and are
 * left alone, and so is anything below 64, which the writer never stores. A
 * wrapper whose string is not JSON was not written by the writer — the row was
 * changed after it was stored, which the chain says — and is left as it is
 * stored rather than thrown on, so a reader still shows the row. For a row
 * with no wrapper, the same object is returned.
 */
export function restoreDataDepth(stored: Record<string, unknown>): Record<string, unknown> {
  return walk(stored, (node) => {
    if (!isMarkerShaped(node)) return node
    try { return JSON.parse((node as Record<string, string>)[COLLAPSED_KEY]) as unknown } catch { return node }
  })
}

// ── JSON text without recursion ─────────────────────────────────────────────

/** A boxed primitive (`Object(5)`): JSON.stringify writes its value. */
function isBoxed(v: object): boolean {
  const tag = Object.prototype.toString.call(v)
  return tag === '[object Number]' || tag === '[object String]' || tag === '[object Boolean]' || tag === '[object BigInt]'
}

/**
 * What JSON.stringify's SerializeJSONProperty makes of `value` held under
 * `key`: `toJSON` called with the key; boxed primitives and scalars as their
 * text (JSON.stringify's own); `undefined` for what it leaves out; or the
 * container to write.
 */
function property(value: unknown, key: string): { text: string | undefined } | { node: Container } {
  if ((isContainer(value) || typeof value === 'function' || typeof value === 'bigint')
      && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    value = (value as { toJSON: (k: string) => unknown }).toJSON(key)
  }
  if (isContainer(value) && !isBoxed(value)) return { node: value }
  return { text: JSON.stringify(value) as string | undefined }
}

/** JSON.stringify(value), byte for byte, for a value of any depth (jsonText).
 *  For a reader that needs the text of a value the writer has not bounded yet
 *  — the AI tailer's size check on a tool input. */
export function jsonStringify(value: unknown): string | undefined {
  const p = property(value, '')
  return 'node' in p ? jsonText(p.node, '', true) : p.text
}

/** Flat output in chunks: one flat string per CHUNK pieces, so a text of
 *  millions of single brackets is not held as millions of pieces. */
const CHUNK = 4096

/** The deepest path jsonText follows. Past it, it throws RangeError as
 *  JSON.stringify does past its stack, instead of growing without limit. Ten
 *  times the doors' ceiling (EVENT_NESTING_CEILING): what reaches here deeper
 *  is RedLog's own producer, and no row of a million levels is evidence. */
const JSON_TEXT_MAX_DEPTH = 1_000_000

/**
 * What JSON.stringify writes for `root` held under `key` (so a `toJSON`
 * receives the key it would there), byte for byte, without recursion: the path
 * is kept in three arrays instead of the call stack, so a container nested up
 * to JSON_TEXT_MAX_DEPTH levels is written where JSON.stringify throws
 * RangeError at a few thousand. A cycle is
 * found by Brent's method on the path (the node at each depth compared with the
 * node at the last power of two above it), which needs no set of visited
 * nodes: a cycle reached by descent repeats with its period, and is found
 * within twice its depth and length.
 */
function jsonText(root: Container, key: string, prepared = false): string {
  const done: string[] = []
  let pieces: string[] = []
  const emit = (s: string): void => {
    pieces.push(s)
    if (pieces.length >= CHUNK) { done.push(pieces.join('')); pieces = [] }
  }
  // `prepared`: `root` is already what SerializeJSONProperty made of the value.
  const first = prepared ? { node: root } : property(root, key)
  if (!('node' in first)) return first.text ?? 'null'
  // Per level of the path: the container, its keys (null for an array), and
  // `2 × next index + (1 if anything is written yet)`.
  const nodes: Container[] = []
  const keyLists: Array<string[] | null> = []
  const state: number[] = []
  const open = (node: Container): void => {
    const depth = nodes.length
    if (depth >= JSON_TEXT_MAX_DEPTH) throw new RangeError(`JSON text deeper than ${JSON_TEXT_MAX_DEPTH} levels`)
    if (depth > 0) {
      const mark = 1 << (31 - Math.clz32(depth))
      if (nodes[mark - 1] === node || nodes[depth - 1] === node) throw new TypeError('Converting circular structure to JSON')
    }
    const keys = Array.isArray(node) ? null : Object.keys(node)
    emit(keys ? '{' : '[')
    nodes.push(node); keyLists.push(keys); state.push(0)
  }
  open(first.node)
  while (nodes.length > 0) {
    const top = nodes.length - 1
    const node = nodes[top]
    const keys = keyLists[top]
    const n = keys ? keys.length : (node as unknown[]).length
    const at = state[top]
    const i = Math.floor(at / 2)
    if (i >= n) {
      emit(keys ? '}' : ']')
      nodes.pop(); keyLists.pop(); state.pop()
      continue
    }
    const key = keys ? keys[i] : String(i)
    const p = property((node as Record<string, unknown>)[key], key)
    if ('text' in p && p.text === undefined && keys) { state[top] = at + 2; continue }
    state[top] = (i + 1) * 2 + 1
    if (at % 2 === 1) emit(',')
    if (keys) emit(JSON.stringify(key) + ':')
    if ('node' in p) open(p.node)
    else emit(p.text ?? 'null')
  }
  done.push(pieces.join(''))
  return done.join('')
}
