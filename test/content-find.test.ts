// The matcher behind "Find in content" (content-find.ts), against an oracle
// built from the body index's own decoder (json-escape-text.ts), at window
// and budget sizes small enough that every escape and every match lands
// across a boundary somewhere.
import { describe, expect, it } from 'vitest'
import { findInSavedText, MAX_RESUME_BACK, type FindPosition } from '../src/core/content-find'
import { decodeJsonEscapes } from '../src/core/json-escape-text'

type Match = { offset: number; bytes: number }

/** Every match, following the continuation, with the given read sizes. */
function walk(text: string | Buffer, needle: string, opts: { budget?: number; window?: number; decode?: boolean } = {}): { matches: Match[]; examined: number; work: number; calls: number } {
  const bytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : text
  const read = (offset: number, length: number): Buffer => bytes.subarray(offset, offset + length)
  const matches: Match[] = []
  let at: FindPosition = { offset: 0, from: 0 }, examined = 0, work = 0, calls = 0
  for (;;) {
    const r = findInSavedText(read, bytes.length, needle, at, opts.budget ?? 1024 * 1024, opts.decode ?? true, opts.window ?? 65536)
    calls++; examined += r.examined; work += r.work
    expect(r.next.offset - r.next.from).toBeGreaterThanOrEqual(0)
    expect(r.next.offset - r.next.from).toBeLessThanOrEqual(MAX_RESUME_BACK)
    if (r.match) matches.push(r.match)
    if (r.next.offset >= bytes.length) return { matches, examined, work, calls }
    expect(r.next.offset).toBeGreaterThan(at.offset)
    at = r.next
  }
}

// ── Oracle ────────────────────────────────────────────────────────────────
// A character of the content with the saved bytes it came from. `index` is
// what the body index puts there (a control-character escape becomes a
// space); find leaves that escape as written, so it is six characters.
interface Token { value: number; start: number; end: number; index: string }

const isHex = (s: string): boolean => /^[0-9a-fA-F]{4}$/.test(s)
function referenceTokens(s: string): Token[] {
  const at: number[] = [0]
  for (let i = 0; i < s.length; i++) at.push(at[i] + Buffer.byteLength(s[i] >= '\ud800' && s[i] <= '\udbff' ? s.slice(i, i + 2) : s[i] >= '\udc00' && s[i] <= '\udfff' ? '' : s[i]))
  const tokens: Token[] = []
  const literal = (i: number): number => {
    const cp = s.codePointAt(i)!, w = cp > 0xffff ? 2 : 1
    tokens.push({ value: cp, start: at[i], end: at[i + w], index: String.fromCodePoint(cp) })
    return i + w
  }
  let i = 0
  while (i < s.length) {
    if (s[i] !== '\\') { i = literal(i); continue }
    let k = i
    while (s[k] === '\\') k++
    const run = k - i
    for (let j = i; j < k - (run % 2); j++) literal(j)
    if (run % 2 === 0) { i = k; continue }
    const esc = k - 1
    const unit = s[k] === 'u' && isHex(s.slice(k + 1, k + 5)) ? parseInt(s.slice(k + 1, k + 5), 16) : -1
    if (unit >= 0xd800 && unit <= 0xdbff && s.slice(k + 5, k + 7) === '\\u' && isHex(s.slice(k + 7, k + 11))) {
      const low = parseInt(s.slice(k + 7, k + 11), 16)
      if (low >= 0xdc00 && low <= 0xdfff) {
        const cp = 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00)
        tokens.push({ value: cp, start: at[esc], end: at[k + 11], index: String.fromCodePoint(cp) }); i = k + 11; continue
      }
    }
    if (unit >= 0 && unit < 0x20) {
      // As written for find; one space for the index.
      for (let j = esc; j < esc + 6; j++) { literal(j); tokens[tokens.length - 1].index = j === esc ? ' ' : '' }
      i = k + 5; continue
    }
    if (unit >= 0 && (unit < 0xd800 || unit > 0xdfff)) {
      tokens.push({ value: unit, start: at[esc], end: at[k + 5], index: String.fromCharCode(unit) }); i = k + 5; continue
    }
    literal(esc); i = k
  }
  return tokens
}
/** Every match by the rule: the earliest start at or after the last end,
 *  the shorter range on a tie. */
function oracle(s: string, needle: string): Match[] {
  const tokens = referenceTokens(s)
  // The reference reads escapes exactly as the index does, or it proves nothing.
  expect(tokens.map(t => t.index).join('')).toBe(decodeJsonEscapes(s) ?? s)
  const bytes = Buffer.from(s, 'utf8'), nb = Buffer.from(needle, 'utf8'), points = Array.from(needle, c => c.codePointAt(0)!)
  const all: Match[] = []
  for (let i = bytes.indexOf(nb); i >= 0; i = bytes.indexOf(nb, i + 1)) all.push({ offset: i, bytes: nb.length })
  for (let t = 0; t + points.length <= tokens.length; t++)
    if (points.every((p, j) => tokens[t + j].value === p)) all.push({ offset: tokens[t].start, bytes: tokens[t + points.length - 1].end - tokens[t].start })
  const out: Match[] = []
  for (let from = 0; ;) {
    const next = all.filter(m => m.offset >= from).sort((a, b) => a.offset - b.offset || a.bytes - b.bytes)[0]
    if (!next) return out
    out.push(next); from = next.offset + next.bytes
  }
}

function rng(seed: number): () => number {
  return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }
}
const PIECES = ['\\', '\\\\', '\\\\\\', 'u', '\\u738b', '\\u5c0f', '\\u738B', '王', '小', '\\ud83d\\ude00', '😀', '\\ud83d', '\\ude00', '\\ud83d\\u0041',
  '\\u000a', '\\u001F', '\\u0020', '\\u0041', 'A', '\\u005c', '\\u12', '\\uZZZZ', '\\users', 'x', ' ', '0', 'd', '8', 'é', '\\U738B', '\\"', '\\n', '\\/']
const NEEDLES = ['王', '王小', '😀', 'A', '\\', 'u', '\\u738b', 'x王', '\\\\', ' ', '\\u005c', 'é', 'A😀', '\\ud83d']

const NAME = '\\u738b\\u5c0f\\u660e'

describe('find in saved text', () => {
  it('matches the oracle on generated content, at every window and budget size', () => {
    const random = rng(1115)
    const pick = <T,>(xs: T[]): T => xs[Math.floor(random() * xs.length)]
    for (let c = 0; c < 1500; c++) {
      let s = ''
      for (let p = Math.floor(random() * 24); p > 0; p--) s += pick(PIECES)
      const tokens = referenceTokens(s), chars = Array.from(s)
      const t0 = Math.floor(random() * tokens.length), raw0 = Math.floor(random() * chars.length)
      const needles = [pick(NEEDLES),
        String.fromCodePoint(...tokens.slice(t0, t0 + 1 + Math.floor(random() * 4)).map(t => t.value)),
        chars.slice(raw0, raw0 + 1 + Math.floor(random() * 6)).join('')].filter(Boolean)
      for (const needle of needles) {
        const expected = oracle(s, needle)
        for (const [window, budget] of [[12, 1], [13, 5], [16, 7], [40, 64], [65536, 1024 * 1024]])
          expect(walk(s, needle, { window, budget }).matches, JSON.stringify({ s, needle, window, budget })).toEqual(expected)
      }
    }
    // Its own budget: this is 1,500 seeded cases of pure CPU and nothing in it
    // waits. On CI it took 2.5 s on macOS and 4.6 s on Linux, and on Windows
    // 10.6 s, 13.9 s and then past the suite's 15 s on two branches at once,
    // neither of which touches this code. A real hang still ends, just later.
  }, 60_000)

  it('finds an 18-byte escaped needle at every alignment across a window and a budget boundary', () => {
    for (const [window, budget] of [[16, 1000], [64, 1000], [1000, 16], [1000, 23], [20, 20]]) {
      for (let lead = 0; lead <= 2 * Math.max(Math.min(window, budget), 18); lead++) {
        const s = 'x'.repeat(lead) + NAME + 'y'.repeat(7) + '王小明'
        expect(walk(s, '王小明', { window, budget }).matches, `lead ${lead}, window ${window}, budget ${budget}`)
          .toEqual([{ offset: lead, bytes: 18 }, { offset: lead + 25, bytes: 9 }])
      }
    }
  })

  it('reads surrogate pairs only together, and leaves a lone surrogate escape as written', () => {
    const s = 'a\\ud83d\\ude00b😀 \\ud83dc \\ude00 \\ud83d\\u0041'
    const at = (part: string): number => Buffer.byteLength(s.slice(0, s.indexOf(part)))
    expect(walk(s, '😀').matches).toEqual([{ offset: 1, bytes: 12 }, { offset: at('😀'), bytes: 4 }])
    expect(walk(s, 'A').matches).toEqual([{ offset: at('\\u0041'), bytes: 6 }])
    expect(walk(s, '\\ud83d').matches.map(m => m.offset)).toEqual([1, at('\\ud83dc'), at('\\ud83d\\u0041')])
    // A lone surrogate in the needle names no character the text can hold.
    expect(walk(s, '\ud83d').matches).toEqual([])
  })

  it('reads no escape that is not four hex digits after an odd run of backslashes', () => {
    const s = 'C:\\users\\x \\u12 \\uZZZZ \\\\u0041 \\\\\\u0041 \\u0009'
    expect(walk(s, 'users').matches).toEqual([{ offset: 3, bytes: 5 }])
    expect(walk(s, 'A').matches).toEqual([{ offset: s.indexOf('\\\\\\u0041') + 2, bytes: 6 }])
    expect(walk(s, 'u0041').matches.length).toBe(2)
    expect(walk(s, '\t').matches).toEqual([])
  })

  it('needs the whole backslash run before an escape, however many calls it spans', () => {
    for (const run of [9999, 10000, 10001, 10002]) {
      const s = '\\'.repeat(run) + 'u738b.'
      const expected = run % 2 ? [{ offset: run - 1, bytes: 6 }] : []
      for (const budget of [997, 1000, 1024, 4999, 5001, 6000]) expect(walk(s, '王', { budget, window: 64 }).matches, `run ${run}, budget ${budget}`).toEqual(expected)
    }
  })

  it('decodes nothing where the index does not', () => {
    expect(walk(`{"name":"${NAME}"}`, '王小明', { decode: false }).matches).toEqual([])
    expect(walk(`{"name":"${NAME}"}`, NAME, { decode: false }).matches).toEqual([{ offset: 9, bytes: 18 }])
  })

  // A counted bound, not a clock: bytes read and loop iterations per byte.
  it.each([
    ['backslashes', '\\'.repeat(1 << 20), '王'],
    ['\\u00 and garbage', '\\u00zz'.repeat((1 << 20) / 6), '王'],
    ['high surrogates without a low', '\\ud83d'.repeat((1 << 20) / 6), '😀'],
    ['escapes that almost match', '\\u0061'.repeat((1 << 20) / 6), 'a'.repeat(600) + 'b'],
    ['bytes that almost match', 'a'.repeat(1 << 20), 'a'.repeat(4095) + 'b']
  ])('stays linear on %s', (_name, text, needle) => {
    const bytes = Buffer.byteLength(text), budget = 1 << 20
    const r = walk(text, needle, { budget, window: 65536 })
    expect(r.matches).toEqual([])
    expect(r.calls).toBe(1)
    expect(r.examined).toBeLessThanOrEqual(bytes + 12 * (Math.ceil(bytes / 65536) + 1))
    expect(r.work).toBeLessThanOrEqual(12 * bytes)
  })
})
