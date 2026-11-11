import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { TerminalOutputPump, type OutputTimers } from '../src/main/terminal-output'
import { TerminalRecording } from '../src/main/terminal-recording'
import { UnbatchedTerminalRecording } from './helpers/terminal-recording-unbatched'

// The terminal's output path (src/main/terminal-output.ts, terminal-recording.ts):
// PTY output reaches the renderer in batches under flow control, and the cast
// is written in batches — byte for byte what a write per frame produced.

const fake = vi.hoisted(() => ({
  panes: [] as Array<{ pid: number; emit: (text: string) => void; exit: (code: number) => void; pause: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn>; paused: boolean }>
}))
vi.mock('node-pty', () => ({ spawn: vi.fn(() => {
  let data: (text: string) => void = () => {}
  let exit: (value: { exitCode: number }) => void = () => {}
  const pane = {
    pid: 2000 + fake.panes.length, paused: false,
    emit: (text: string) => data(text), exit: (code: number) => exit({ exitCode: code }),
    kill: vi.fn(), write: vi.fn(), resize: vi.fn(),
    pause: vi.fn(() => { pane.paused = true }), resume: vi.fn(() => { pane.paused = false }),
    onData: (fn: typeof data) => { data = fn }, onExit: (fn: typeof exit) => { exit = fn }
  }
  fake.panes.push(pane)
  return pane
}) }))
vi.mock('electron', () => ({ BrowserWindow: class {} }))
vi.mock('../src/core/cast-index', () => ({ indexCast: vi.fn(async () => undefined) }))
import { initDB, closeDB } from '../src/core/db/index'
import { configureIngest, _resetIngest } from '../src/core/ingest'
import { eventBus } from '../src/core/event-bus'
import { ensurePrimaryOperator, generateToken } from '../src/core/db/operators'
import { configureTerminal, spawnTerminal, killAllTerminals, getCastPosition, setTerminalWindow, ackTerminal } from '../src/main/terminal-manager'

function fakeTimers(): OutputTimers & { advance: (ms: number) => void; at: number } {
  let at = 0
  let seq = 0
  const due = new Map<number, { when: number; fn: () => void }>()
  const t = {
    get at() { return at },
    now: () => at,
    set: (fn: () => void, ms: number) => { const id = ++seq; due.set(id, { when: at + ms, fn }); return id },
    clear: (h: unknown) => { due.delete(h as number) },
    advance(ms: number) {
      const end = at + ms
      for (;;) {
        const next = [...due].filter(([, d]) => d.when <= end).sort((a, b) => a[1].when - b[1].when || a[0] - b[0])[0]
        if (!next) break
        due.delete(next[0])
        at = next[1].when
        next[1].fn()
      }
      at = end
    }
  }
  return t
}

describe('TerminalOutputPump', () => {
  it('turns a flood of 50 000 chunks into a bounded number of sends, and never holds more than one batch', () => {
    const timers = fakeTimers()
    const sent: string[] = []
    let paused = false
    const pump = new TerminalOutputPump({
      send: (d) => sent.push(d), pause: () => { paused = true }, resume: () => { paused = false }, timers
    })
    // A shell that writes up to 32 chunks of 4 KiB a millisecond whenever it is
    // not paused, and a renderer that parses 2 000 000 characters a second and
    // acknowledges in steps.
    const chunk = 'y\n'.repeat(2048)
    let produced = 0
    let parsedOwed = 0
    let maxPending = 0
    let maxUnacked = 0
    while (produced < 50_000) {
      for (let k = 0; k < 32 && !paused && produced < 50_000; k++) {
        pump.push(chunk)
        produced++
        maxPending = Math.max(maxPending, pump.pending)
        maxUnacked = Math.max(maxUnacked, pump.unacked)
      }
      timers.advance(1)
      parsedOwed += 2000
      if (parsedOwed >= 5000 && pump.unacked > 0) { pump.ack(Math.min(parsedOwed, pump.unacked)); parsedOwed = 0 }
    }
    pump.flush()
    expect(sent.join('').length).toBe(50_000 * chunk.length)
    // A send per 5 ms or per 64 KiB, whichever comes first — never one per chunk.
    expect(sent.length).toBeLessThanOrEqual(Math.ceil(timers.at / 5) + Math.ceil((50_000 * chunk.length) / (64 * 1024)) + 1)
    expect(sent.length).toBeLessThan(50_000 / 10)
    expect(maxPending).toBeLessThan(64 * 1024 + chunk.length)
    // Backpressure held the renderer's backlog near the high-water mark.
    expect(maxUnacked).toBeLessThanOrEqual(100_000 + 64 * 1024 + chunk.length)
  })

  it('keeps every character in order across pauses and resumes', () => {
    const timers = fakeTimers()
    const sent: string[] = []
    let paused = false
    let pauses = 0
    const pump = new TerminalOutputPump({ send: (d) => sent.push(d), pause: () => { paused = true; pauses++ }, resume: () => { paused = false }, timers })
    const pushed: string[] = []
    for (let i = 0; i < 5000; i++) {
      if (paused) { pump.ack(pump.unacked); continue }
      const piece = `${i}:${'x'.repeat(i % 97)}|`
      pushed.push(piece)
      pump.push(piece)
      if (i % 7 === 0) timers.advance(5)
    }
    pump.flush()
    expect(pauses).toBeGreaterThan(0)
    expect(sent.join('')).toBe(pushed.join(''))
  })

  it('sends what it holds when flushed (the shell exited)', () => {
    const sent: string[] = []
    const pump = new TerminalOutputPump({ send: (d) => sent.push(d), pause: () => {}, resume: () => {}, timers: fakeTimers() })
    pump.push('last ')
    pump.push('words')
    expect(sent).toEqual([])
    pump.flush()
    expect(sent).toEqual(['last words'])
  })

  it('pauses above the high-water mark, resumes below the low one', () => {
    const timers = fakeTimers()
    const calls: string[] = []
    const pump = new TerminalOutputPump({ send: () => {}, pause: () => calls.push('pause'), resume: () => calls.push('resume'), timers, highWater: 1000, lowWater: 100, maxChars: 400 })
    for (let i = 0; i < 3; i++) pump.push('a'.repeat(400))
    expect(calls).toEqual(['pause'])
    pump.ack(1000)
    expect(calls).toEqual(['pause'])
    pump.ack(150)
    expect(calls).toEqual(['pause', 'resume'])
  })

  it('does not hold a shell paused for a renderer that stopped acknowledging', () => {
    const timers = fakeTimers()
    const calls: string[] = []
    const pump = new TerminalOutputPump({ send: () => {}, pause: () => calls.push('pause'), resume: () => calls.push('resume'), timers, highWater: 1000, maxChars: 2000, stallMs: 2000 })
    pump.push('a'.repeat(2000))
    expect(calls).toEqual(['pause'])
    timers.advance(1999)
    expect(calls).toEqual(['pause'])
    timers.advance(1)
    expect(calls).toEqual(['pause', 'resume'])
    // Unpaced until acknowledgements come back.
    pump.push('b'.repeat(2000))
    expect(calls).toEqual(['pause', 'resume'])
    pump.ack(10)
    pump.push('c'.repeat(2000))
    expect(calls).toEqual(['pause', 'resume', 'pause'])
  })

  it('starts over for a renderer that re-attached', () => {
    const timers = fakeTimers()
    const calls: string[] = []
    const sent: string[] = []
    const pump = new TerminalOutputPump({ send: (d) => sent.push(d), pause: () => calls.push('pause'), resume: () => calls.push('resume'), timers, highWater: 1000, maxChars: 2000 })
    pump.push('a'.repeat(2000))
    pump.push('held')
    pump.reattach()
    expect(calls).toEqual(['pause', 'resume'])
    expect(pump.unacked).toBe(0)
    timers.advance(10)
    expect(sent).toEqual(['a'.repeat(2000)])
  })
})

describe('the buffered cast writer', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
  const dir = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-castbuf-')); dirs.push(d); return d }

  for (const [label, maxBytes] of [['one part', 50 * 1024 * 1024], ['many small parts', 400]] as const) {
    it(`writes exactly what a write per frame wrote: ${label}`, async () => {
      let seed = 9
      const r = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
      const pieces = ['ls -la\r\n', '中文輸出\r\n', '🙂', '\x1b[31mred\x1b[0m', 'x'.repeat(300), '"quoted"\\', '']
      const frames: Array<[number, 'o' | 'r', string]> = []
      let t = 0
      for (let i = 0; i < 3000; i++) {
        t += r() / 10
        frames.push(r() < 0.03 ? [t, 'r', `${80 + (i % 40)}x24`] : [t, 'o', pieces[Math.floor(r() * pieces.length)] + String(i)])
      }
      const header = { version: 2, width: 80, height: 24, timestamp: 1_700_000_000 }
      const a = dir(), b = dir()
      const ref = new UnbatchedTerminalRecording(path.join(a, 's.cast'), header, maxBytes)
      const buf = new TerminalRecording(path.join(b, 's.cast'), header, maxBytes)
      for (const f of frames) {
        expect(buf.append(f)).toBe(ref.append(f))
        expect(buf.bytes).toBe(ref.bytes)
        // Wait out the flush timer now and then, as the main loop would.
        if (r() < 0.01) await new Promise((res) => setTimeout(res, 60))
      }
      const refClosed = ref.close()
      const bufClosed = buf.close()
      expect(bufClosed.sha256).toBe(refClosed.sha256)
      expect(bufClosed.bytes).toBe(refClosed.bytes)
      expect(bufClosed.segments.map((s) => [path.basename(s.path), s.bytes, s.sha256]))
        .toEqual(refClosed.segments.map((s) => [path.basename(s.path), s.bytes, s.sha256]))
      for (const s of refClosed.segments) {
        expect(fs.readFileSync(path.join(b, path.basename(s.path)))).toEqual(fs.readFileSync(s.path))
      }
    })
  }
})

describe('a pane under a flood', () => {
  let root: string
  let homeSpy: ReturnType<typeof vi.spyOn>
  const sends: Array<[string, unknown]> = []
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-flood-'))
    homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(root)
    fake.panes.length = 0
    sends.length = 0
    eventBus.resume('ui')
    _resetIngest()
    initDB(path.join(root, 'P'))
    ensurePrimaryOperator('operator', 'Operator', generateToken())
    configureTerminal({ identity: { projectId: 'P', engagementId: 'P', operatorId: 'operator' } })
    configureIngest({ castProbe: getCastPosition })
    setTerminalWindow({ isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => sends.push([channel, payload]) } } as never)
  })
  afterEach(() => { killAllTerminals(); closeDB(); _resetIngest(); homeSpy.mockRestore(); vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }) })

  const dataSends = (id: string): string[] => sends.filter(([c]) => c === `terminal:data:${id}`).map(([, p]) => p as string)

  it('sends 50 000 chunks in a bounded number of messages, pauses the pty for a renderer that has not caught up, and delivers all of it in order', () => {
    vi.useFakeTimers()
    spawnTerminal('flood', 80, 24)
    const pane = fake.panes[0]
    let expected = ''
    for (let i = 0; i < 50_000; i++) {
      const chunk = `line ${i}\r\n`
      expected += chunk
      pane.emit(chunk)
      if (i % 500 === 0) vi.advanceTimersByTime(5)
    }
    vi.advanceTimersByTime(5)
    const messages = dataSends('flood')
    expect(messages.join('')).toBe(expected)
    expect(messages.length).toBeLessThan(200)
    // Nobody acknowledged: the pty was paused once the backlog passed the mark.
    expect(pane.pause).toHaveBeenCalled()
    expect(pane.paused).toBe(true)
    ackTerminal('flood', expected.length)
    expect(pane.paused).toBe(false)
  })

  it('records every chunk as its own frame, at its own time, identical to a write per frame', () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 })
    spawnTerminal('rec', 80, 24)
    const pane = fake.panes[0]
    const castPath = getCastPosition('rec')!.castPath
    const start = Date.now()
    const frames: Array<[number, 'o', string]> = []
    for (let i = 0; i < 2000; i++) {
      vi.advanceTimersByTime(i % 3)
      const chunk = `out ${i} ${'·'.repeat(i % 13)}\r\n`
      frames.push([(Date.now() - start) / 1000, 'o', chunk])
      pane.emit(chunk)
    }
    killAllTerminals()
    const header = JSON.parse(fs.readFileSync(castPath, 'utf8').split('\n')[0])
    const refPath = path.join(root, 'ref.cast')
    const ref = new UnbatchedTerminalRecording(refPath, header, 50 * 1024 * 1024)
    for (const f of frames) ref.append(f)
    ref.close()
    expect(fs.readFileSync(castPath)).toEqual(fs.readFileSync(refPath))
  })

  it('delivers everything the shell printed before it reports the exit', () => {
    vi.useFakeTimers()
    spawnTerminal('bye', 80, 24)
    const pane = fake.panes[0]
    pane.emit('goodbye ')
    pane.emit('world\r\n')
    pane.exit(0)
    const order = sends.filter(([c]) => c.endsWith(':bye') && (c.startsWith('terminal:data') || c.startsWith('terminal:exit'))).map(([c, p]) => c.startsWith('terminal:exit') ? 'EXIT' : p)
    expect(order).toEqual(['goodbye world\r\n', 'EXIT'])
  })

  it('keeps showing output, in order, while the recording is paused, and records none of it', () => {
    vi.useFakeTimers()
    spawnTerminal('held', 80, 24)
    const pane = fake.panes[0]
    const castPath = getCastPosition('held')!.castPath
    pane.emit('before|')
    eventBus.pause('ui')
    pane.emit('during-1|')
    pane.emit('during-2|')
    eventBus.resume('ui')
    pane.emit('after|')
    vi.advanceTimersByTime(5)
    expect(dataSends('held').join('')).toBe('before|during-1|during-2|after|')
    killAllTerminals()
    const cast = fs.readFileSync(castPath, 'utf8')
    expect(cast).toContain('before|')
    expect(cast).toContain('after|')
    expect(cast).not.toContain('during-')
  })
})
