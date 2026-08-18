import { describe, it, expect } from 'vitest'
import {
  inferPhaseSuggestions,
  type EventLike,
  type InferredPhase
} from '../src/renderer/src/lib/phaseInference'

// This is the DESIGN-PRINCIPLES §3 SUGGESTION layer — never authoritative.
// Every property asserted here is a promise the seam makes to the operator:
// the output is `inferred`, confidence-scored, and carries a sourceEventId so a
// single click can promote a suggestion into an authoritative marker. These
// tests pin the conservative event-type → phase mapping and the boundary logic
// (adjacent de-dup, sort-before-process), not any ATT&CK opinion.

// Tiny builder so each case reads as "an event of this type, at this ts".
let seq = 0
function ev(agentType: string, ts: number, data?: EventLike['data']): EventLike {
  return { id: `e${seq++}`, timestamp: ts, agentType, data }
}

describe('inferPhaseSuggestions — mapping table', () => {
  it('maps pivot → lateral-movement, high', () => {
    const [s] = inferPhaseSuggestions([ev('pivot', 10)])
    expect(s.phase).toBe('lateral-movement')
    expect(s.confidence).toBe('high')
    expect(s.reason).toBe('pivot/tunnel detected')
  })

  it('maps file_transfer with exfil direction → exfil, medium', () => {
    const [s] = inferPhaseSuggestions([ev('file_transfer', 10, { direction: 'exfil' })])
    expect(s.phase).toBe('exfil')
    expect(s.confidence).toBe('medium')
  })

  it('maps file_transfer with exfil subtype → exfil, medium', () => {
    const [s] = inferPhaseSuggestions([ev('file_transfer', 10, { subtype: 'exfil' })])
    expect(s.phase).toBe('exfil')
    expect(s.confidence).toBe('medium')
  })

  it('maps ingress file_transfer → delivery, low', () => {
    const [s] = inferPhaseSuggestions([ev('file_transfer', 10, { direction: 'ingress' })])
    expect(s.phase).toBe('delivery')
    expect(s.confidence).toBe('low')
  })

  it('treats a file_transfer with no direction as delivery (conservative default)', () => {
    const [s] = inferPhaseSuggestions([ev('file_transfer', 10)])
    expect(s.phase).toBe('delivery')
    expect(s.confidence).toBe('low')
  })

  it('maps cleanup → anti-forensics, high', () => {
    const [s] = inferPhaseSuggestions([ev('cleanup', 10)])
    expect(s.phase).toBe('anti-forensics')
    expect(s.confidence).toBe('high')
  })

  it('maps credential_use → credential-access, medium', () => {
    const [s] = inferPhaseSuggestions([ev('credential_use', 10)])
    expect(s.phase).toBe('credential-access')
    expect(s.confidence).toBe('medium')
  })

  it('maps loot → credential-access, medium', () => {
    const [s] = inferPhaseSuggestions([ev('loot', 10)])
    expect(s.phase).toBe('credential-access')
    expect(s.confidence).toBe('medium')
  })

  it('maps scanner / dns / http_navigation → recon, low', () => {
    for (const t of ['scanner', 'dns', 'http_navigation']) {
      const [s] = inferPhaseSuggestions([ev(t, 10)])
      expect(s.phase).toBe('recon')
      expect(s.confidence).toBe('low')
    }
  })

  it('produces no suggestion for unmapped event types', () => {
    expect(inferPhaseSuggestions([ev('marker', 10)])).toEqual([])
    expect(inferPhaseSuggestions([ev('screenshot', 10)])).toEqual([])
    expect(inferPhaseSuggestions([ev('system', 10)])).toEqual([])
  })
})

describe('inferPhaseSuggestions — boundary logic', () => {
  it('returns [] for empty input', () => {
    expect(inferPhaseSuggestions([])).toEqual([])
  })

  it('collapses adjacent duplicate phases to the first transition point only', () => {
    // Three recon-ish events in a row are one recon boundary, not three. We mark
    // where the phase STARTS, not every event inside it.
    const out = inferPhaseSuggestions([
      ev('dns', 10),
      ev('scanner', 20),
      ev('http_navigation', 30),
      ev('pivot', 40)
    ])
    expect(out.map((s) => s.phase)).toEqual(['recon', 'lateral-movement'])
    // the recon boundary is the first (dns) event, at ts 10
    expect(out[0].ts).toBe(10)
  })

  it('re-enters a phase after leaving it (non-adjacent repeats are kept)', () => {
    const out = inferPhaseSuggestions([
      ev('dns', 10), // recon
      ev('pivot', 20), // lateral-movement
      ev('scanner', 30) // recon again — a new boundary, not a duplicate
    ])
    expect(out.map((s) => s.phase)).toEqual(['recon', 'lateral-movement', 'recon'])
  })

  it('sorts unsorted input by ts before processing', () => {
    const out = inferPhaseSuggestions([
      ev('pivot', 40),
      ev('dns', 10),
      ev('scanner', 20),
      ev('cleanup', 50)
    ])
    expect(out.map((s) => s.phase)).toEqual(['recon', 'lateral-movement', 'anti-forensics'])
    expect(out.map((s) => s.ts)).toEqual([10, 40, 50])
  })

  it('orders a multi-phase engagement by ts', () => {
    const out = inferPhaseSuggestions([
      ev('dns', 10),
      ev('credential_use', 20),
      ev('pivot', 30),
      ev('file_transfer', 40, { direction: 'exfil' }),
      ev('cleanup', 50)
    ])
    expect(out.map((s) => s.phase)).toEqual([
      'recon',
      'credential-access',
      'lateral-movement',
      'exfil',
      'anti-forensics'
    ])
  })
})

describe('inferPhaseSuggestions — suggestion-layer contract', () => {
  it('carries the triggering event id as sourceEventId', () => {
    const dns = ev('dns', 10)
    const pivot = ev('pivot', 20)
    const out = inferPhaseSuggestions([dns, pivot])
    expect(out[0].sourceEventId).toBe(dns.id)
    expect(out[1].sourceEventId).toBe(pivot.id)
  })

  it('sourceEventId of a collapsed run points at the first event of the run', () => {
    const first = ev('dns', 10)
    const second = ev('scanner', 20)
    const out = inferPhaseSuggestions([first, second])
    expect(out).toHaveLength(1)
    expect(out[0].sourceEventId).toBe(first.id)
  })

  it('every suggestion is confidence-scored with a valid tier', () => {
    const out: InferredPhase[] = inferPhaseSuggestions([
      ev('pivot', 10),
      ev('loot', 20),
      ev('dns', 30)
    ])
    for (const s of out) {
      expect(['low', 'medium', 'high']).toContain(s.confidence)
    }
  })
})
