// The textual \uXXXX decoder the body index uses for search
// (src/core/json-escape-text.ts). It must agree with what a JSON parser makes
// of each escape it decodes, leave everything else alone, and stay linear on
// input a target chooses.
import { describe, expect, it } from 'vitest'
import { decodeJsonEscapes, jsonEscapeDecoder } from '../src/core/json-escape-text'

const B = '\\'
const esc = (hex: string): string => `${B}u${hex}`

function streamed(text: string, cuts: number[]): string {
  const d = jsonEscapeDecoder()
  let out = '', at = 0
  for (const cut of cuts) { out += d.push(text.slice(at, cut)); at = cut }
  return out + d.push(text.slice(at)) + d.end()
}

describe('decodeJsonEscapes', () => {
  it('decodes BMP escapes and leaves the rest of the text as it was', () => {
    expect(decodeJsonEscapes(`{"q":"${esc('4e2d')}${esc('6587')}${esc('8a5e')}","n":1}`)).toBe('{"q":"中文詞","n":1}')
    expect(decodeJsonEscapes(`Z${esc('00FC')}rich`)).toBe('Zürich')
  })

  it('returns null for text with nothing to decode', () => {
    expect(decodeJsonEscapes('plain {"a":"b"} text')).toBeNull()
    expect(decodeJsonEscapes('')).toBeNull()
    expect(decodeJsonEscapes(`${B}n${B}t${B}"`)).toBeNull()
  })

  it('combines a high and low surrogate escape into one astral character', () => {
    expect(decodeJsonEscapes(`${esc('d83d')}${esc('de00')}`)).toBe('😀')
    expect(decodeJsonEscapes(`a${esc('D840')}${esc('DC0B')}b`)).toBe('a𠀋b')
  })

  it('leaves lone surrogates as written', () => {
    expect(decodeJsonEscapes(esc('d83d'))).toBeNull()
    expect(decodeJsonEscapes(esc('de00'))).toBeNull()
    expect(decodeJsonEscapes(`${esc('d83d')}x`)).toBeNull()
    // a high surrogate followed by another high: the second still pairs with what follows it
    expect(decodeJsonEscapes(`${esc('d800')}${esc('d83d')}${esc('de00')}`)).toBe(`${esc('d800')}😀`)
    // low before high is two lone surrogates
    expect(decodeJsonEscapes(`${esc('de00')}${esc('d83d')}`)).toBeNull()
  })

  it('decodes only after an odd run of backslashes', () => {
    expect(decodeJsonEscapes(`${B}${B}u4e2d`)).toBeNull()
    expect(decodeJsonEscapes(`${B}${B}${B}u4e2d`)).toBe(`${B}${B}中`)
    expect(decodeJsonEscapes(`${B}${B}${B}${B}u4e2d`)).toBeNull()
    expect(decodeJsonEscapes(`${B}${B}${B}${B}${B}u4e2d!`)).toBe(`${B}${B}${B}${B}中!`)
    // the low half of a pair behind an escaped backslash is not an escape
    expect(decodeJsonEscapes(`${esc('d83d')}${B}${B}ude00`)).toBeNull()
  })

  it('does nothing on malformed sequences', () => {
    for (const bad of [`${B}u`, `${B}u4e`, `${B}u4e2`, `${B}u4e2g`, `${B}uXXXX`, `${B}U4e2d`, `${B}${B}`, B, `${B}u${B}u4e2d`.slice(0, 3)])
      expect(decodeJsonEscapes(bad), bad).toBeNull()
    // a broken escape does not hide the valid one right after it
    expect(decodeJsonEscapes(`${B}u12${esc('4e2d')}`)).toBe(`${B}u12中`)
  })

  it('agrees with JSON.parse on every escape it decodes', () => {
    for (const hex of ['0041', '00e9', '4e2d', 'ffff', 'fffd', '2028', 'D83D', 'DE00']) {
      const text = `"x${esc(hex)}y"`
      const decoded = decodeJsonEscapes(text)
      const parsed = JSON.parse(text) as string
      // JSON.parse also accepts lone surrogates; the decoder leaves those.
      if (/^d[89ab]/i.test(hex) || /^d[c-f]/i.test(hex)) expect(decoded).toBeNull()
      else expect(decoded).toBe(`"${parsed}"`)
    }
    const pair = `"${esc('d83d')}${esc('de00')}"`
    expect(decodeJsonEscapes(pair)).toBe(`"${JSON.parse(pair) as string}"`)
  })

  it('mixes with real UTF-8 text untouched', () => {
    expect(decodeJsonEscapes(`已有中文 ${esc('4e2d')} 😀 é`)).toBe('已有中文 中 😀 é')
  })

  it('turns a decoded control character into a space, never a NUL', () => {
    expect(decodeJsonEscapes(`line1${esc('000a')}line2${esc('0000')}x`)).toBe('line1 line2 x')
  })
})

describe('jsonEscapeDecoder (pieces)', () => {
  const samples = [
    `a${esc('4e2d')}b${esc('d83d')}${esc('de00')}c`,
    `${B}${B}${B}${esc('00fc')}${B}${B}u0041${esc('d83d')}x${esc('dc00')}`,
    `${B}u12${esc('4e2d')}${B}`,
    `${esc('d83d')}${B}${B}ude00${esc('D840')}${esc('DC0B')}`
  ]
  it('gives the same text wherever the pieces are cut', () => {
    for (const text of samples) {
      const whole = decodeJsonEscapes(text) ?? text
      for (let a = 0; a <= text.length; a++)
        for (let b = a; b <= text.length; b++)
          expect(streamed(text, [a, b]), `${JSON.stringify(text)} cut at ${a},${b}`).toBe(whole)
    }
  })

  it('reports whether anything was decoded', () => {
    const plain = jsonEscapeDecoder(); plain.push('abc'); plain.push(`${B}${B}u4e2d`); plain.end()
    expect(plain.changed).toBe(false)
    const split = jsonEscapeDecoder(); split.push(`x${B}u4e`); expect(split.changed).toBe(false)
    split.push('2d'); split.end()
    expect(split.changed).toBe(true)
  })
})

describe('linear time on adversarial input', () => {
  const MB20 = 20 * 1024 * 1024
  const cases: Array<[string, string]> = [
    ['backslashes', B.repeat(MB20)],
    ['\\u prefixes', `${B}u`.repeat(MB20 / 2)],
    ['valid escapes', esc('4e2d').repeat(MB20 / 6)],
    ['lone high surrogates', esc('d83d').repeat(MB20 / 6)],
    ['near-escapes', `${B}u4e2`.repeat(MB20 / 5)]
  ]
  for (const [name, text] of cases) {
    it(`20 MB of ${name}, whole and in 1 MiB pieces`, () => {
      // A quadratic scan of 20 MB takes hours; a linear one well under a second.
      let started = performance.now()
      decodeJsonEscapes(text)
      const whole = performance.now() - started
      started = performance.now()
      const d = jsonEscapeDecoder()
      for (let at = 0; at < text.length; at += 1 << 20) d.push(text.slice(at, at + (1 << 20)))
      d.end()
      const pieces = performance.now() - started
      console.log(`[scanner] ${name}: whole ${whole.toFixed(0)} ms, pieces ${pieces.toFixed(0)} ms`)
      expect(whole).toBeLessThan(5000)
      expect(pieces).toBeLessThan(5000)
    }, 30000)
  }
})
