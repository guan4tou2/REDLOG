import { describe, it, expect } from 'vitest'
import { monotonicNs, getNtpOffsetMs, getLastNtpQuery } from '../src/core/clock'

describe('clock', () => {
  it('monotonicNs returns a numeric string', () => {
    const ns = monotonicNs()
    expect(typeof ns).toBe('string')
    expect(ns).toMatch(/^\d+$/)
    expect(BigInt(ns)).toBeGreaterThan(0n)
  })

  it('monotonicNs is monotonically increasing', () => {
    const a = BigInt(monotonicNs())
    const b = BigInt(monotonicNs())
    expect(b).toBeGreaterThanOrEqual(a)
  })

  it('getNtpOffsetMs returns null or a number', () => {
    const offset = getNtpOffsetMs()
    expect(offset === null || typeof offset === 'number').toBe(true)
  })

  it('getLastNtpQuery returns a number', () => {
    const last = getLastNtpQuery()
    expect(typeof last).toBe('number')
  })
})
