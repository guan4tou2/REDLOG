import { describe, expect, it } from 'vitest'
import { hasUnsafeText, safeDisplay } from '../src/renderer/src/lib/evidenceText'

// #549: an untrusted producer controls `command`, `url`, `target` and output.
// A direction override there reorders the rendered line, so what the operator
// reads is not what the evidence says. Display has to show that one is there.
describe('evidence-safe display', () => {
  it('leaves ordinary text alone', () => {
    const s = 'echo 認證測試 | curl https://example.com/a?b=1 😀'
    expect(safeDisplay(s)).toBe(s)
    expect(hasUnsafeText(s)).toBe(false)
  })

  it('names a right-to-left override instead of applying it', () => {
    // "REVERSED" between RLO and PDF used to render as "DESREVER".
    const raw = 'echo \u202eREVERSED\u202c zero'
    expect(safeDisplay(raw)).toBe('echo ⟨RLO⟩REVERSED⟨PDF⟩ zero')
  })

  it('names the isolating controls and the zero-width joiners', () => {
    expect(safeDisplay('a\u2066b\u2069c')).toBe('a⟨LRI⟩b⟨PDI⟩c')
    expect(safeDisplay('ad\u200bmin')).toBe('ad⟨ZWSP⟩min')
    expect(safeDisplay('\ufeffpayload')).toBe('⟨BOM⟩payload')
  })

  it('marks line and paragraph separators, which break a line invisibly', () => {
    expect(safeDisplay('one\u2028two')).toBe('one⟨LS⟩two')
    expect(safeDisplay('one\u2029two')).toBe('one⟨PS⟩two')
  })

  it('reports whether it would change anything, without changing it', () => {
    expect(hasUnsafeText('plain')).toBe(false)
    expect(hasUnsafeText('has\u202eone')).toBe(true)
    // Repeated calls must see the same answer (the shared regex is stateful
    // only while `g` is set, and `hasUnsafeText` resets it).
    expect(hasUnsafeText('has\u202eone')).toBe(true)
    expect(hasUnsafeText('plain')).toBe(false)
  })
})
