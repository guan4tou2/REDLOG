import { describe, it, expect, vi, afterEach } from 'vitest'
import { ProjectRuntime } from '../src/core/project-runtime'

// What the main process gets from one place instead of from module variables:
// which open a piece of async work belongs to, and a stop that reaches every
// timer and cleanup that open started, even when one of them throws.

const A = { id: 'p-a', name: 'Alpha', createdAt: 1, lastOpened: 2, path: '/projects/a' }
const B = { ...A, id: 'p-b', name: 'Beta', path: '/projects/b' }
const IDS = { engagementId: 'eng-a', operatorId: 'op-a' }

afterEach(() => { vi.useRealTimers() })

describe('ProjectRuntime', () => {
  it('walks opening → active → closed, and a new open is a new generation', () => {
    const runtime = new ProjectRuntime()
    expect(runtime.state).toBe('closed')
    const first = runtime.begin(A, IDS)
    expect(runtime.state).toBe('opening')
    runtime.activate(first)
    expect(runtime.state).toBe('active')
    runtime.close()
    expect(runtime.state).toBe('closed')
    expect(first.signal.aborted).toBe(true)
    const second = runtime.begin(A, IDS)
    expect(second.generation).toBeGreaterThan(first.generation)
  })

  it('tells work from an earlier open of the same project apart from the current one', () => {
    // A → B → A. A project id cannot say the first A is over; a generation can.
    const runtime = new ProjectRuntime()
    const firstA = runtime.begin(A, IDS); runtime.activate(firstA); runtime.close()
    const b = runtime.begin(B, IDS); runtime.activate(b); runtime.close()
    const secondA = runtime.begin(A, IDS); runtime.activate(secondA)
    expect(runtime.isCurrent(firstA)).toBe(false)
    expect(runtime.isCurrent(secondA)).toBe(true)
  })

  it('reports a close before activation as a failed open', () => {
    const runtime = new ProjectRuntime()
    runtime.begin(A, IDS)
    runtime.close()
    expect(runtime.state).toBe('failed')
    expect(runtime.current()).toBeNull()
  })

  it('runs every cleanup, newest first, and rethrows the first failure', () => {
    const runtime = new ProjectRuntime()
    const ctx = runtime.begin(A, IDS)
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
    const ctx = runtime.begin(A, IDS)
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
    const old = runtime.begin(A, IDS); runtime.activate(old); runtime.close()
    const next = runtime.begin(A, IDS); runtime.activate(next)
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
    runtime.activate(runtime.begin(A, IDS))
    expect(() => runtime.begin(A, IDS)).toThrow(/still active/)
  })

  // Settings can change the operator id while the project stays open. Every
  // source holds the open's context, so the change has to reach them through
  // it: same open, same engagement, the new operator from the next write on.
  it('changes the operator of the live open without ending it', () => {
    const runtime = new ProjectRuntime()
    const open = runtime.begin(A, IDS); runtime.activate(open)
    const held = open
    expect(runtime.setOperator(open, 'op-b')).toBe(true)
    expect(held.operatorId).toBe('op-b')
    expect(runtime.current()?.operatorId).toBe('op-b')
    expect(runtime.current()).toBe(open)
    expect(open.engagementId).toBe('eng-a')
    expect(open.generation).toBe(held.generation)
    expect(open.signal.aborted).toBe(false)
    expect(runtime.isCurrent(open)).toBe(true)
  })

  it('will not change the operator of an open that has ended', () => {
    const runtime = new ProjectRuntime()
    const first = runtime.begin(A, IDS); runtime.activate(first); runtime.close()
    const second = runtime.begin(A, IDS); runtime.activate(second)
    expect(runtime.setOperator(first, 'op-b')).toBe(false)
    expect(first.operatorId).toBe('op-a')
    expect(second.operatorId).toBe('op-a')
  })

  // The open project itself, not just its id: what the main process used to
  // keep in a module variable of its own, set and cleared at different
  // moments from the open it belonged to.
  it('holds the open project from begin until close', () => {
    const runtime = new ProjectRuntime()
    expect(runtime.project()).toBeNull()
    const open = runtime.begin(A, IDS)
    expect(runtime.project()).toEqual(A)
    runtime.activate(open)
    expect(runtime.project()?.id).toBe('p-a')
    // A cleanup of the open is taking it down, not acting on it.
    let seenByCleanup: unknown = 'not run'
    runtime.onStop(open, () => { seenByCleanup = runtime.project() })
    runtime.close()
    expect(seenByCleanup).toBeNull()
    expect(runtime.project()).toBeNull()
  })

  it('keeps its own copy, so the caller cannot change the open project behind it', () => {
    const runtime = new ProjectRuntime()
    const meta = { ...A }
    runtime.begin(meta, IDS)
    meta.name = 'changed'
    expect(runtime.project()?.name).toBe('Alpha')
  })

  it('renames the open project without ending the open', () => {
    const runtime = new ProjectRuntime()
    const open = runtime.begin(A, IDS)
    runtime.activate(open)
    expect(runtime.renameProject(open, 'Alpha 2')).toBe(true)
    expect(runtime.project()).toEqual({ ...A, name: 'Alpha 2' })
    expect(runtime.isCurrent(open)).toBe(true)
  })

  it('will not rename through an open that has ended', () => {
    const runtime = new ProjectRuntime()
    const first = runtime.begin(A, IDS); runtime.activate(first); runtime.close()
    const second = runtime.begin(A, IDS); runtime.activate(second)
    expect(runtime.renameProject(first, 'stale')).toBe(false)
    expect(runtime.project()?.name).toBe('Alpha')
  })

  it('keeps the engagement fixed for the life of an open', () => {
    const runtime = new ProjectRuntime()
    const open = runtime.begin(A, IDS)
    expect(() => { (open as { engagementId: string }).engagementId = 'eng-b' }).toThrow()
    expect(open.engagementId).toBe('eng-a')
  })
})
