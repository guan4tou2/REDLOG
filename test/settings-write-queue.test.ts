import { describe, expect, it, vi } from 'vitest'
import { createSettingsWriteQueue } from '../src/renderer/src/lib/settingsWriteQueue'

describe('settings writes survive navigation and finish before project close', () => {
  it('waits for an in-flight write and then persists the newest edit', async () => {
    let release!: (ok: boolean) => void
    const save = vi.fn().mockImplementationOnce(() => new Promise<boolean>(r => { release = r })).mockResolvedValue(true)
    const queue = createSettingsWriteQueue(save)
    queue.stage('a', { name: 'first' })
    const first = queue.flush('a')
    await Promise.resolve()
    queue.stage('a', { name: 'last' })
    let finished = false
    const closing = queue.flush('a').then(ok => { finished = true; return ok })
    expect(finished).toBe(false)
    release(true)
    expect(await first).toBe(true)
    expect(await closing).toBe(true)
    expect(save.mock.calls).toEqual([['a', { name: 'first' }], ['a', { name: 'last' }]])
  })

  it('retains rejected data for a retry instead of allowing a successful close', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(true)
    const queue = createSettingsWriteQueue(save)
    queue.stage('a', { scope: ['10.0.0.1'] })
    expect(await queue.flush('a')).toBe(false)
    expect(await queue.flush('a')).toBe(true)
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('never flushes one project into another project', async () => {
    const save = vi.fn().mockResolvedValue(true)
    const queue = createSettingsWriteQueue(save)
    queue.stage('a', { name: 'A' })
    expect(await queue.flush('b')).toBe(true)
    expect(save).not.toHaveBeenCalled()
    expect(await queue.flush('a')).toBe(true)
    expect(save).toHaveBeenCalledWith('a', { name: 'A' })
  })
})
