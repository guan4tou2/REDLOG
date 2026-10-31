import { describe, it, expect } from 'vitest'
import { bodyTruncation } from '../src/core/content-contract'

// #290: "truncated" alone does not say how much was kept or how much there
// was. A body cut at the cap reports both; an unknown total stays unknown.
describe('bodyTruncation', () => {
  it('reads a sidecar body as stored bytes of the total the producer saw', () => {
    expect(bodyTruncation(undefined, { size: 10 << 20, truncated: true, totalSize: 16 << 20 })).toEqual({ saved: 10 << 20, total: 16 << 20 })
  })

  it('leaves the total unknown when nobody reported one', () => {
    expect(bodyTruncation(undefined, { size: 10 << 20, truncated: true })).toEqual({ saved: 10 << 20, total: null })
  })

  it('measures an inline body in bytes, not characters', () => {
    expect(bodyTruncation({ data: '中文', encoding: 'text', size: 600, truncated: true }, undefined)).toEqual({ saved: 6, total: 600 })
    expect(bodyTruncation({ data: Buffer.from([1, 2, 3, 4]).toString('base64'), encoding: 'base64', size: 9, truncated: true }, undefined)).toEqual({ saved: 4, total: 9 })
  })

  it('is null for a body that was kept whole', () => {
    expect(bodyTruncation({ data: 'whole', encoding: 'text', size: 5 }, undefined)).toBeNull()
    expect(bodyTruncation(undefined, { size: 5000 })).toBeNull()
    expect(bodyTruncation(undefined, undefined)).toBeNull()
  })
})
