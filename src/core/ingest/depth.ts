// How deep a row's `data` may nest (Spec 071 FR-097).
//
// Both verifiers walk `data` recursively to rebuild a row's hash. Python's
// stops at its recursion limit, and a row nested past it reads there as CHAIN
// BROKEN although nothing in it changed; SQLite's json_tree, which fills the
// search index on every insert, refuses JSON nested past 1000 levels, and so
// does the insert. A producer that can send `data` — the events API, a handoff
// file, an AI tool's input, an HTTP body the proxy parsed — decides how deep it
// is. So the writer bounds it, and does so without losing anything (complete
// capture, DECISIONS 2026-11-13 §12): a container that would sit deeper than
// MAX_DATA_DEPTH is replaced, where it stands, by a string holding its JSON
// text exactly as JSON.stringify writes it. `JSON.parse` of that string gives
// the container back. The stamp counts the replacements (`_ingest.collapsed`),
// so a reader can tell a collapsed container from a string the producer sent.
//
// Counting: `data` itself is depth 1; an array or object directly inside it is
// depth 2, and so on. Scalars, strings included, add no level. A row's stored
// JSON therefore never nests more than MAX_DATA_DEPTH brackets below the row.
//
// 64 against what is measured (2026-11-14; spec 071 plan.md D13): the deepest
// `data` any fixture or golden in this repository holds is 3; the deepest AI
// tool input across 323,816 local Claude Code and Codex tool calls is 5 (6 as
// `data.tool_input`); an HTTP JSON body the proxy parses sits at depth 3, so a
// body nested 61 levels is kept as it is. The Python verifier fails to rebuild
// a row at 332 levels of arrays on Python 3.9 and 3.11 (497 on 3.12–3.15), the
// app's own verifier near 2,300, SQLite's json_tree at 1,001.
//
// Values are treated as JSON data, which is what every door delivers (parsed
// JSON, or plain literals in-process). Within the limit nothing is copied or
// changed: the same object is returned.

/** The deepest a container may sit in a row's `data`, `data` being depth 1. */
export const MAX_DATA_DEPTH = 64

type Container = Record<string, unknown> | unknown[]

const isContainer = (v: unknown): v is Container => v !== null && typeof v === 'object'

/**
 * `data` with every container that would sit deeper than MAX_DATA_DEPTH
 * replaced by its JSON text, and how many were replaced. `data` itself is never
 * changed; when nothing needs replacing it is returned as it is.
 *
 * The walk above the limit recurses at most MAX_DATA_DEPTH frames, and the text
 * of a replaced container is written without recursion (jsonText), so no input
 * is deep enough to overflow the stack here. A cycle, which JSON cannot hold,
 * throws as JSON.stringify does.
 */
export function boundDataDepth(data: Record<string, unknown>): { data: Record<string, unknown>; collapsed: number } {
  let collapsed = 0
  // The copy is made only on the path to a replaced container; everything
  // else keeps its identity.
  const bound = (node: Container, depth: number): Container => {
    let out: Container | null = null
    const keys = Array.isArray(node) ? null : Object.keys(node)
    const n = keys ? keys.length : (node as unknown[]).length
    for (let i = 0; i < n; i++) {
      const key = keys ? keys[i] : i
      const child = (node as Record<string | number, unknown>)[key]
      if (!isContainer(child)) continue
      let next: unknown
      if (depth + 1 > MAX_DATA_DEPTH) {
        next = jsonText(child)
        collapsed++
      } else {
        next = bound(child, depth + 1)
        if (next === child) continue
      }
      if (out === null) out = Array.isArray(node) ? node.slice() : { ...node }
      ;(out as Record<string | number, unknown>)[key] = next
    }
    return out ?? node
  }
  const out = bound(data, 1) as Record<string, unknown>
  return { data: out, collapsed }
}

/** A value JSON.stringify writes by itself: anything that is not a plain
 *  array or object (a Date, a Buffer, a class instance), or has toJSON. */
function writtenByStringify(v: object): boolean {
  if (typeof (v as { toJSON?: unknown }).toJSON === 'function') return true
  if (Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v) as unknown
  return proto !== Object.prototype && proto !== null
}

interface Frame {
  node: Container
  keys: string[] | null
  i: number
  written: number
}

/**
 * JSON.stringify(container), byte for byte, without recursion: an explicit
 * stack instead of the call stack, so a container nested 100,000 levels is
 * written where JSON.stringify would throw RangeError. Scalars, keys and the
 * values JSON.stringify writes by itself (writtenByStringify) are handed to
 * JSON.stringify, so their text is its text; `undefined`, functions and symbols
 * are left out of objects and written `null` in arrays, as it does.
 */
function jsonText(root: Container): string {
  if (writtenByStringify(root)) return JSON.stringify(root)
  const parts: string[] = []
  const onPath = new Set<object>()
  const stack: Frame[] = []
  const open = (node: Container): void => {
    if (onPath.has(node)) throw new TypeError('Converting circular structure to JSON')
    onPath.add(node)
    const keys = Array.isArray(node) ? null : Object.keys(node)
    parts.push(keys ? '{' : '[')
    stack.push({ node, keys, i: 0, written: 0 })
  }
  open(root)
  while (stack.length > 0) {
    const f = stack[stack.length - 1]
    const n = f.keys ? f.keys.length : (f.node as unknown[]).length
    if (f.i >= n) {
      parts.push(f.keys ? '}' : ']')
      onPath.delete(f.node)
      stack.pop()
      continue
    }
    const key = f.keys ? f.keys[f.i] : null
    const value = f.keys ? (f.node as Record<string, unknown>)[key!] : (f.node as unknown[])[f.i]
    f.i++
    const nested = isContainer(value) && !writtenByStringify(value)
    const text = nested ? null : JSON.stringify(value) as string | undefined
    if (!nested && text === undefined && key !== null) continue
    if (f.written++ > 0) parts.push(',')
    if (key !== null) parts.push(JSON.stringify(key), ':')
    if (nested) open(value as Container)
    else parts.push(text ?? 'null')
  }
  return parts.join('')
}
