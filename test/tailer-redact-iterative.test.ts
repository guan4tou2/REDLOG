// deepRedactStrings (tailer-host.ts) became iterative so a deep AI tool input
// no longer overflows the stack (Spec 071 FR-097). This holds it to the
// recursive version it replaced, kept below verbatim, over random nested
// values: the same output — keys, values, holes, prototypes (an own
// `__proto__` key sets the copy's prototype, as `out[k] =` always did), and
// `[cyclic]` for a cycle or a shared object — for every input that one handled.

import { describe, expect, it } from 'vitest'
import { deepRedactStrings } from '../src/main/services/tailer-host'
import { redactSecrets } from '../src/core/secret-redaction'

/** The recursive version, as it stood before this change. */
function recursiveDeepRedactStrings(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return redactSecrets(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value as object)) return '[cyclic]'
  seen.add(value as object)
  if (Array.isArray(value)) return value.map((v) => recursiveDeepRedactStrings(v, seen))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = recursiveDeepRedactStrings(v, seen)
  }
  return out
}

/** Everything about a value that either version could get wrong: shape,
 *  holes, own keys in order, scalar values, and each object's prototype as
 *  the place it points to. */
function describeValue(root: unknown): string {
  const ids = new Map<object, number>()
  const lines: string[] = []
  const visit = (v: unknown, path: string): void => {
    if (v === null || typeof v !== 'object') { lines.push(`${path} = ${typeof v}:${typeof v === 'number' && Object.is(v, -0) ? '-0' : String(v)}`); return }
    if (ids.has(v)) { lines.push(`${path} = ref#${ids.get(v)}`); return }
    ids.set(v, ids.size)
    const proto = Object.getPrototypeOf(v) as object | null
    const protoName = proto === Object.prototype ? 'Object' : proto === Array.prototype ? 'Array' : proto === null ? 'null' : `obj(${JSON.stringify(proto)})`
    if (Array.isArray(v)) {
      lines.push(`${path} = array#${ids.get(v)} len ${v.length} proto ${protoName}`)
      for (let i = 0; i < v.length; i++) i in v ? visit(v[i], `${path}[${i}]`) : lines.push(`${path}[${i}] = <hole>`)
    } else {
      lines.push(`${path} = object#${ids.get(v)} keys ${JSON.stringify(Object.keys(v))} proto ${protoName}`)
      for (const k of Object.keys(v)) visit((v as Record<string, unknown>)[k], `${path}.${k}`)
    }
  }
  visit(root, '$')
  return lines.join('\n')
}

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Secret-shaped strings assembled at run time (the repository's secret scanner
// reports literals).
const TOKEN = ['gh', 'p_'].join('') + 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0FeDcBa98'
const SCALARS: unknown[] = ['', 'plain', `uses ${TOKEN}`, TOKEN, 'é\u{1F600}', 0, -0, 1.5, true, false, null, undefined, NaN]
const KEYS = ['a', 'b', '0', '10', '__proto__', 'tok', '']

function value(r: () => number, depth: number, pool: object[]): unknown {
  if (depth > 6 || r() < 0.25) return SCALARS[Math.floor(r() * SCALARS.length)]
  if (pool.length > 0 && r() < 0.1) return pool[Math.floor(r() * pool.length)] // shared, or a cycle
  const width = Math.floor(r() * 4)
  if (r() < 0.45) {
    const arr: unknown[] = new Array(width)
    pool.push(arr)
    for (let i = 0; i < width; i++) if (r() > 0.15) arr[i] = value(r, depth + 1, pool) // some holes
    return arr
  }
  const obj: Record<string, unknown> = {}
  pool.push(obj)
  for (let i = 0; i < width; i++) {
    Object.defineProperty(obj, KEYS[Math.floor(r() * KEYS.length)], { value: value(r, depth + 1, pool), enumerable: true, writable: true, configurable: true })
  }
  return obj
}

describe('deepRedactStrings: iterative, the same output as the recursive version', () => {
  it('over 3,000 random values: holes, shared objects, cycles, own `__proto__` keys, secrets', () => {
    let withProto = 0, withCycle = 0
    for (let seed = 1; seed <= 3000; seed++) {
      const input = value(rng(seed), 0, [])
      const want = describeValue(recursiveDeepRedactStrings(input))
      const got = describeValue(deepRedactStrings(input))
      expect(got, `seed ${seed}`).toBe(want)
      if (want.includes('proto obj(')) withProto++
      if (want.includes('[cyclic]')) withCycle++
    }
    // The generator does reach the awkward cases.
    expect(withProto).toBeGreaterThan(50)
    expect(withCycle).toBeGreaterThan(50)
  })

  it('a secret is masked at depth 80 and at depth 50,000; the recursive version overflowed long before', () => {
    let v: unknown = { k: `x ${TOKEN}` }
    for (let i = 0; i < 50_000; i++) v = i === 49_920 ? [v, `y ${TOKEN}`] : [v]
    expect(() => recursiveDeepRedactStrings(v)).toThrow(RangeError)
    const out = deepRedactStrings(v)
    let text = ''
    // Walk without recursion to collect the strings.
    const stack: unknown[] = [out]
    while (stack.length) { const x = stack.pop(); if (typeof x === 'string') text += x + '\n'; else if (x && typeof x === 'object') stack.push(...Object.values(x)) }
    expect(text).not.toContain(TOKEN)
    expect(text.split('\n').filter((s) => s.startsWith('x ') || s.startsWith('y '))).toHaveLength(2)
  })
})
