import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAckBatcher, createFitScheduler } from '../src/renderer/src/lib/terminalFlow'
import { ACK_EVERY_CHARS } from '../src/main/terminal-output'

describe('createAckBatcher', () => {
  it('acknowledges in steps, never one message per write, and loses no characters', () => {
    const sent: number[] = []
    const ack = createAckBatcher((n) => sent.push(n))
    let total = 0
    for (let i = 0; i < 10_000; i++) { const n = 1 + (i % 37); total += n; ack(n) }
    expect(sent.length).toBeLessThanOrEqual(Math.ceil(total / ACK_EVERY_CHARS))
    expect(sent.every((n) => n >= ACK_EVERY_CHARS)).toBe(true)
    // What is still owed is under one step — below main's low-water mark.
    expect(total - sent.reduce((a, b) => a + b, 0)).toBeLessThan(ACK_EVERY_CHARS)
  })

  it('acknowledges a single large write at once', () => {
    const sent: number[] = []
    const ack = createAckBatcher((n) => sent.push(n), 100)
    ack(250)
    expect(sent).toEqual([250])
  })
})

describe('createFitScheduler', () => {
  afterEach(() => { vi.useRealTimers() })

  it('fits once after a drag stops, not on every frame of it', () => {
    vi.useFakeTimers()
    const fit = vi.fn()
    const s = createFitScheduler(fit, 60, (cb) => cb())
    for (let i = 0; i < 30; i++) { s.schedule(); vi.advanceTimersByTime(16) }
    expect(fit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60)
    expect(fit).toHaveBeenCalledTimes(1)
  })

  it('does not fit a pane that went away', () => {
    vi.useFakeTimers()
    const fit = vi.fn()
    const s = createFitScheduler(fit, 60, (cb) => cb())
    s.schedule()
    s.cancel()
    vi.advanceTimersByTime(200)
    expect(fit).not.toHaveBeenCalled()
  })
})
