import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import * as cp from 'child_process'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawnSync: vi.fn(actual.spawnSync),
  }
})

const { detectHooksAsync, getCachedHooks, invalidateHooksCache, invalidateCommandCache } = await import('../src/core/hooks-manager')

describe('hook availability probing stays off the main thread', () => {
  beforeEach(() => {
    ;(cp.spawnSync as unknown as Mock).mockClear()
    invalidateHooksCache()
    invalidateCommandCache()
  })

  it('detectHooksAsync populates the cache', async () => {
    expect(getCachedHooks()).toBeNull()
    const hooks = await detectHooksAsync()
    expect(hooks.length).toBeGreaterThan(0)
    expect(getCachedHooks()).not.toBeNull()
    expect(getCachedHooks()!.length).toBe(hooks.length)
  })

  it('getCachedHooks returns immediately after detectHooksAsync', async () => {
    await detectHooksAsync()
    ;(cp.spawnSync as unknown as Mock).mockClear()
    const cached = getCachedHooks()
    expect(cached).not.toBeNull()
    expect(cached!.length).toBeGreaterThan(0)
  })

  it('invalidateHooksCache clears the cache', async () => {
    await detectHooksAsync()
    expect(getCachedHooks()).not.toBeNull()
    invalidateHooksCache()
    expect(getCachedHooks()).toBeNull()
  })
})
