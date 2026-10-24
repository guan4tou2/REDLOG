import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// The follower counts the commands it has emitted per transcript. That count
// used to advance past every new command whether or not its row was written,
// so a failed write was never tried again — a command the transcript holds and
// the record does not. And a change seen while paused left the count behind,
// so the first change after resume recorded everything typed during the pause.

const h = vi.hoisted(() => ({
  watchers: [] as Array<{ open: boolean; handlers: Map<string, Array<(p: string) => void>> }>,
  written: [] as string[],
  failOn: new Set<string>(),
  paused: false
}))

vi.mock('chokidar', () => {
  const watch = (): unknown => {
    const w = { open: true, handlers: new Map<string, Array<(p: string) => void>>() }
    h.watchers.push(w)
    const api = {
      on(event: string, cb: (p: string) => void) { w.handlers.set(event, [...(w.handlers.get(event) ?? []), cb]); return api },
      close: async () => { w.open = false }
    }
    return api
  }
  return { default: { watch }, watch }
})
vi.mock('../src/core/ingest', () => ({
  ingest: (input: { data: { command: string } }) => {
    if (h.failOn.has(input.data.command)) throw new Error('SQLITE_BUSY')
    h.written.push(input.data.command)
    return { event: null, companions: [] }
  }
}))
vi.mock('../src/core/event-bus', () => ({ eventBus: { get paused() { return h.paused } } }))
vi.mock('../src/core/capture-health', () => ({ noteDbError: () => {} }))

const HEADER = [
  '**********************',
  'Windows PowerShell transcript start',
  'Start time: 20261024120000',
  'Machine: DESKTOP-7',
  '**********************'
]
const transcript = (...cmds: string[]): string => [...HEADER, ...cmds.flatMap((c) => [`PS C:\\> ${c}`, 'out'])].join('\n')

const fire = (event: string, p: string): void => {
  for (const w of h.watchers) if (w.open) for (const cb of w.handlers.get(event) ?? []) cb(p)
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

let home: string
let file: string
let pt: typeof import('../src/main/services/powershell-transcript')
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }

beforeEach(async () => {
  vi.resetModules()
  h.watchers.length = 0
  h.written.length = 0
  h.failOn.clear()
  h.paused = false
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-ps-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  const dir = path.join(home, '.redlog', 'transcripts')
  fs.mkdirSync(dir, { recursive: true })
  file = path.join(dir, 'session.txt')
  pt = await import('../src/main/services/powershell-transcript')
  await pt.configurePowershellTranscript({ enabled: true, engagementId: 'eng', operatorId: 'op' })
  await settle()
})

afterEach(() => {
  pt.stopPowershellTranscript()
  vi.useRealTimers()
  for (const key of ['HOME', 'USERPROFILE'] as const) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  fs.rmSync(home, { recursive: true, force: true })
})

describe('a command whose write fails', () => {
  it('is written by the next change, along with what came after it', () => {
    fs.writeFileSync(file, transcript('whoami', 'nmap -sV 10.0.0.5', 'hostname'))
    h.failOn.add('nmap -sV 10.0.0.5')
    fire('add', file)
    // Stops at the failure: hostname is not written ahead of the command before it.
    expect(h.written).toEqual(['whoami'])

    h.failOn.clear()
    fs.writeFileSync(file, transcript('whoami', 'nmap -sV 10.0.0.5', 'hostname', 'ipconfig'))
    fire('change', file)
    expect(h.written).toEqual(['whoami', 'nmap -sV 10.0.0.5', 'hostname', 'ipconfig'])
  })

  it('is retried on its own when no further change comes', async () => {
    vi.useFakeTimers()
    fs.writeFileSync(file, transcript('whoami', 'exit'))
    h.failOn.add('exit')
    fire('add', file)
    expect(h.written).toEqual(['whoami'])

    h.failOn.clear()
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.written).toEqual(['whoami', 'exit'])
  })

  it('stops retrying after a bounded number of attempts', async () => {
    vi.useFakeTimers()
    fs.writeFileSync(file, transcript('exit'))
    h.failOn.add('exit')
    let attempts = 0
    const real = h.failOn.has.bind(h.failOn)
    h.failOn.has = (c: string) => { if (c === 'exit') attempts++; return real(c) }
    fire('add', file)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    // The first try, then five retries.
    expect(attempts).toBe(6)
  })

  it('is never written twice', () => {
    fs.writeFileSync(file, transcript('whoami', 'hostname'))
    h.failOn.add('hostname')
    fire('add', file)
    h.failOn.clear()
    fire('change', file)
    fire('change', file)
    expect(h.written).toEqual(['whoami', 'hostname'])
  })
})

describe('commands run while recording is paused', () => {
  it('are not recorded when recording resumes', () => {
    fs.writeFileSync(file, transcript('whoami'))
    fire('add', file)

    h.paused = true
    fs.writeFileSync(file, transcript('whoami', 'private-command'))
    fire('change', file)
    h.paused = false

    fs.writeFileSync(file, transcript('whoami', 'private-command', 'nmap -sV 10.0.0.5'))
    fire('change', file)
    expect(h.written).toEqual(['whoami', 'nmap -sV 10.0.0.5'])
  })
})
