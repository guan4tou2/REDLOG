import { it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runRound, startCanary } from './helpers/stall-canary.mjs'

it.each([false, true])('canary reports a slow step and removes every artifact (sync=%s)', sync => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-test-'))
  try {
    let ticks = 0
    const lines: string[] = []
    runRound(base, 'tmp', sync, { now: () => (++ticks >= 4 ? 300 : 0), write: (line: string) => lines.push(line), timestamp: () => '12:34:56.789' })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\[canary\] 12:34:56\.789 tmp (no)?sync /)
    const steps = JSON.parse(lines[0].slice(lines[0].indexOf('{')))
    expect(steps.create).toBe(300)
    expect(Object.keys(steps)).toEqual(['mkdtemp', 'create', 'write', ...(sync ? ['fsync'] : []), 'close', 'read', 'rename', 'unlink', 'rmdir'])
    expect(fs.readdirSync(base)).toEqual([])
  } finally { vi.restoreAllMocks(); fs.rmSync(base, { recursive: true, force: true }) }
})
it('a clean round is silent and leaves no files', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-clean-'))
  try {
    const lines: string[] = []
    const read = vi.spyOn(fs, 'readFileSync')
    for (const sync of [false, true]) runRound(base, 'repo', sync, { now: () => 0, write: (line: string) => lines.push(line) })
    expect(lines).toEqual([])
    expect(read).toHaveBeenCalledTimes(2)
    expect(read.mock.results.map(result => result.value.length)).toEqual([4096, 4096])
    read.mockRestore()
    expect(fs.readdirSync(base)).toEqual([])
  } finally { vi.restoreAllMocks(); fs.rmSync(base, { recursive: true, force: true }) }
})

it('cleans up the open handle and directory after a failed step', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-failure-'))
  const failure = new Error('injected disk failure')
  const write = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw failure })
  try {
    expect(() => runRound(base, 'tmp', true)).toThrow(failure)
    expect(fs.readdirSync(base)).toEqual([])
  } finally { write.mockRestore(); fs.rmSync(base, { recursive: true, force: true }) }
})

it('deduplicates interval errors and stops when the parent disappears', () => {
  vi.useFakeTimers()
  const listeners = process.listenerCount('disconnect')
  const output = vi.spyOn(console, 'error').mockImplementation(() => {})
  const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => { throw new Error('disk unavailable') })
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  const stop = startCanary()
  try {
    vi.advanceTimersByTime(1000)
    expect(output.mock.calls[0][0]).toMatch(/^\[canary\] bases tmp=.+ repo=.+test-results$/)
    expect(output.mock.calls.filter(([line]) => line === '[canary] error disk unavailable')).toHaveLength(1)
    expect(mkdir).toHaveBeenCalledTimes(4)
    kill.mockImplementation(() => { throw new Error('parent gone') })
    vi.advanceTimersByTime(1000)
    expect(mkdir).toHaveBeenCalledTimes(4)
    expect(vi.getTimerCount()).toBe(0)
    expect(process.listenerCount('disconnect')).toBe(listeners)
  } finally { stop(); vi.restoreAllMocks(); vi.useRealTimers() }
})
