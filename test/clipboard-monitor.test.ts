import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The clipboard monitor (src/main/clipboard-monitor.ts) against a fake
// clipboard and fake timers. What matters most is the pack switch: config:save
// and project open both configure the monitor more than once in one
// synchronous run, and each restart awaits the clipboard before it arms the
// poll. Two restarts used to interleave there, arm two timers and lose one, so
// turning Host monitors off left clipboard capture running (TESTING.md G-CB2).

const h = vi.hoisted(() => ({
  text: '',
  reads: 0,
  events: [] as Array<Record<string, unknown>>
}))

vi.mock('electron', () => ({
  clipboard: { readText: () => { h.reads++; return h.text } }
}))
vi.mock('../src/core/ingest', () => ({
  ingestEvent: (_type: string, data: Record<string, unknown>) => { h.events.push(data); return null }
}))
vi.mock('../src/core/capture-health', () => ({ noteDbError: () => {} }))

let monitor: typeof import('../src/main/clipboard-monitor')

const IDS = { engagementId: 'eng', operatorId: 'op' }
const ON = { enabled: true, pollMs: 500, ...IDS }

/** Let every restart in flight get past its clipboard read. */
const settle = (): Promise<void> => vi.advanceTimersByTimeAsync(0)
/** Put something new on the clipboard and give every poller time to see it. */
const copy = async (text: string): Promise<void> => {
  h.text = text
  await vi.advanceTimersByTimeAsync(5_000)
}

beforeEach(async () => {
  vi.useFakeTimers()
  // The monitor keeps its timer and config in module state; each case gets a
  // fresh copy.
  vi.resetModules()
  h.text = 'on the clipboard before capture started'
  h.reads = 0
  h.events.length = 0
  monitor = await import('../src/main/clipboard-monitor')
})

afterEach(() => {
  monitor.stopClipboardMonitor()
  vi.useRealTimers()
})

describe('clipboard monitor — what it captures', () => {
  it('captures a change once, and never what was there before it started', async () => {
    monitor.configureClipboardMonitor(ON)
    await settle()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.events, 'the seeded content predates the session').toHaveLength(0)

    await copy('first copy')
    expect(h.events).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.events, 'the same content read again is one event').toHaveLength(1)
  })

  it('captures nothing, and reads nothing, with the pack off from the start', async () => {
    monitor.configureClipboardMonitor({ enabled: false, ...IDS })
    monitor.startClipboardMonitor()
    await settle()
    await copy('copied while the pack is off')
    expect(h.events).toHaveLength(0)
    expect(h.reads).toBe(0)
  })

  it('clamps pollMs up to 500 ms', async () => {
    monitor.configureClipboardMonitor({ ...ON, pollMs: 100 })
    await settle()
    h.text = 'copied'
    await vi.advanceTimersByTimeAsync(499)
    expect(h.events).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.events).toHaveLength(1)
  })

  it('stores no text with storePreview off', async () => {
    monitor.configureClipboardMonitor(ON)
    await settle()
    await copy('line one\nline two')
    expect(h.events[0]).toMatchObject({ subtype: 'clipboard_changed', length: 17, lines: 2, preview: null })
    expect(h.events[0].sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('with storePreview on, stores the first 120 characters with only the flagged spans masked', async () => {
    // Everything redaction does not flag is stored as copied.
    // Built, not written out. What the test needs is entropy: redaction flags a
    // token at >= 4.5 bits/char, and 32 *distinct* characters is exactly
    // log2(32) = 5. But a 32-character high-entropy literal is also precisely
    // what a real credential looks like, so the repo's secret scanner flags it
    // — GitGuardian failed this PR on it, and it is the second fixture to trip
    // that (see the mongodb loot fixture before it). Composing the characters
    // keeps the property and leaves no credential-shaped string in the source.
    const secret = [
      ...Array.from({ length: 10 }, (_, i) => String(i)),                    // 0-9
      ...Array.from({ length: 22 }, (_, i) => String.fromCharCode(97 + i))   // a-v
    ].join('')
    monitor.configureClipboardMonitor({ ...ON, storePreview: true })
    await settle()
    await copy(`token ${secret} and ${'x'.repeat(200)}`)
    const preview = String(h.events[0].preview)
    expect(preview).toHaveLength(120)
    expect(preview.startsWith(`token ${'•'.repeat(32)} and xxx`)).toBe(true)
  })
})

describe('clipboard monitor — pausing', () => {
  // Nothing from the paused window may reach the record. Resuming is treated
  // like starting: what is on the clipboard then is seeded, not captured
  // (TESTING.md G-CB1).
  it('does not capture, on resume, what was copied during the pause', async () => {
    const { eventBus } = await import('../src/core/event-bus')
    monitor.configureClipboardMonitor(ON)
    await settle()
    eventBus.pause('ui')
    await copy('copied while paused')
    eventBus.resume('ui')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.events, 'the paused copy, still on the clipboard').toHaveLength(0)

    await copy('copied after resuming')
    expect(h.events).toHaveLength(1)
  })

  it('does not read the clipboard while paused', async () => {
    const { eventBus } = await import('../src/core/event-bus')
    monitor.configureClipboardMonitor(ON)
    await settle()
    eventBus.pause('ui')
    const before = h.reads
    await copy('copied while paused')
    expect(h.reads).toBe(before)
  })
})

describe('clipboard monitor — turning it off', () => {
  // config:save in src/main/index.ts: the options first, then applyCapturePacks
  // switches the pack — two configure calls in one synchronous run.
  const save = (packOn: boolean): void => {
    monitor.configureClipboardMonitor({ pollMs: 500, storePreview: false, ...IDS })
    monitor.configureClipboardMonitor({ enabled: packOn })
  }

  it('stops capturing when a Settings save turns the pack off', async () => {
    monitor.configureClipboardMonitor(ON)
    await settle()
    save(false)
    await settle()
    await copy('copied after the pack was turned off')
    expect(h.events).toHaveLength(0)
  })

  it('keeps one poller however many saves restart it', async () => {
    monitor.configureClipboardMonitor(ON)
    await settle()
    save(true)
    save(true)
    await settle()
    const before = h.reads
    await vi.advanceTimersByTimeAsync(500)
    expect(h.reads - before, 'clipboard reads in one poll interval').toBe(1)

    // And the save that turns the pack off leaves nothing behind.
    save(false)
    await settle()
    await copy('copied after the pack was turned off')
    expect(h.events).toHaveLength(0)
  })

  it('stops when a project with the pack off opens after one with it on', async () => {
    // stopProject, then startProject: configure, start, then applyCapturePacks.
    monitor.configureClipboardMonitor(ON)
    await settle()
    monitor.stopClipboardMonitor()
    monitor.configureClipboardMonitor({ pollMs: 500, storePreview: false, engagementId: 'eng2', operatorId: 'op2' })
    monitor.startClipboardMonitor()
    monitor.configureClipboardMonitor({ enabled: false })
    await settle()
    await copy('copied in a project with the pack off')
    expect(h.events).toHaveLength(0)
  })

  it('does not arm a poll after a stop that lands while it waits on the clipboard', async () => {
    monitor.configureClipboardMonitor(ON)
    monitor.stopClipboardMonitor()
    await settle()
    await copy('copied after the monitor was stopped')
    expect(h.events).toHaveLength(0)
  })
})
