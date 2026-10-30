import { describe, it, expect, vi, afterEach } from 'vitest'
import { ProjectRuntime } from '../src/core/project-runtime'

// What the main process gets from one place instead of from module variables:
// which open a piece of async work belongs to, and a stop that reaches every
// timer and cleanup that open started, even when one of them throws.

const IDS = { projectId: 'p-a', engagementId: 'eng-a', operatorId: 'op-a' }

afterEach(() => { vi.useRealTimers() })

describe('ProjectRuntime', () => {
  it('walks opening → active → closed, and a new open is a new generation', () => {
    const runtime = new ProjectRuntime()
    expect(runtime.state).toBe('closed')
    const first = runtime.begin(IDS)
    expect(runtime.state).toBe('opening')
    runtime.activate(first)
    expect(runtime.state).toBe('active')
    runtime.close()
    expect(runtime.state).toBe('closed')
    expect(first.signal.aborted).toBe(true)
    const second = runtime.begin(IDS)
    expect(second.generation).toBeGreaterThan(first.generation)
  })

  it('tells work from an earlier open of the same project apart from the current one', () => {
    // A → B → A. A project id cannot say the first A is over; a generation can.
    const runtime = new ProjectRuntime()
    const firstA = runtime.begin(IDS); runtime.activate(firstA); runtime.close()
    const b = runtime.begin({ ...IDS, projectId: 'p-b' }); runtime.activate(b); runtime.close()
    const secondA = runtime.begin(IDS); runtime.activate(secondA)
    expect(runtime.isCurrent(firstA)).toBe(false)
    expect(runtime.isCurrent(secondA)).toBe(true)
  })

  it('reports a close before activation as a failed open', () => {
    const runtime = new ProjectRuntime()
    runtime.begin(IDS)
    runtime.close()
    expect(runtime.state).toBe('failed')
    expect(runtime.current()).toBeNull()
  })

  it('runs every cleanup, newest first, and rethrows the first failure', () => {
    const runtime = new ProjectRuntime()
    const ctx = runtime.begin(IDS)
    const order: string[] = []
    runtime.onStop(ctx, () => { order.push('first') })
    runtime.onStop(ctx, () => { order.push('second'); throw new Error('second broke') })
    runtime.onStop(ctx, () => { order.push('third'); throw new Error('third broke') })
    runtime.activate(ctx)
    expect(() => runtime.close()).toThrow('third broke')
    expect(order).toEqual(['third', 'second', 'first'])
    expect(runtime.state).toBe('closed')
  })

  it('stops the timers an open started, and never fires one for a closed open', () => {
    vi.useFakeTimers()
    const runtime = new ProjectRuntime()
    const ctx = runtime.begin(IDS)
    const ticks: string[] = []
    runtime.setInterval(ctx, () => ticks.push('interval'), 1000)
    runtime.setTimeout(ctx, () => ticks.push('timeout'), 1500)
    runtime.activate(ctx)
    vi.advanceTimersByTime(1000)
    expect(ticks).toEqual(['interval'])
    runtime.close()
    vi.advanceTimersByTime(10_000)
    expect(ticks).toEqual(['interval'])
  })

  it('refuses to attach work to an open that has already ended', () => {
    // A late `.then` that tries to register a timer for an open that closed
    // under it must not leave a timer running into the next project.
    vi.useFakeTimers()
    const runtime = new ProjectRuntime()
    const old = runtime.begin(IDS); runtime.activate(old); runtime.close()
    const next = runtime.begin(IDS); runtime.activate(next)
    const fired = vi.fn()
    runtime.setInterval(old, fired, 10)
    const cleanup = vi.fn()
    runtime.onStop(old, cleanup)
    vi.advanceTimersByTime(100)
    expect(fired).not.toHaveBeenCalled()
    // Registered against an ended open, a cleanup runs at once rather than
    // waiting for a stop that already happened.
    expect(cleanup).toHaveBeenCalledOnce()
    runtime.close()
  })

  it('will not begin while an open is still live', () => {
    const runtime = new ProjectRuntime()
    runtime.activate(runtime.begin(IDS))
    expect(() => runtime.begin(IDS)).toThrow(/still active/)
  })
})
