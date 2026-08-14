// clipboard.{enabled,pollMs,storePreview} — the three most privacy-sensitive
// switches in the config. `storePreview` in particular decides whether any
// clipboard text at all reaches disk, so "off means off" needs an assertion,
// not a code comment.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

let clipboardText = ''
const inserted: Array<{ type: string; data: Record<string, unknown> }> = []

vi.mock('electron', () => ({ clipboard: { readText: () => clipboardText } }))

vi.mock('../src/core/db/events', () => ({
  insertEvent: (type: string, data: Record<string, unknown>) => {
    inserted.push({ type, data })
    return { id: `e${inserted.length}`, agentType: type, data }
  }
}))

const { configureClipboardMonitor, stopClipboardMonitor } = await import('../src/main/clipboard-monitor')
const { eventBus } = await import('../src/core/event-bus')

/** Set the clipboard, let one poll fire, and return any event it produced. */
function poll(text: string): Record<string, unknown> | undefined {
  clipboardText = text
  vi.advanceTimersByTime(5000)
  return inserted[inserted.length - 1]?.data
}

beforeEach(() => {
  vi.useFakeTimers()
  inserted.length = 0
  clipboardText = ''
  if (eventBus.paused) eventBus.resume()
})

afterEach(() => {
  stopClipboardMonitor()
  vi.useRealTimers()
})

describe('clipboard.enabled', () => {
  it('off (the default) polls nothing, whatever lands on the clipboard', () => {
    configureClipboardMonitor({ enabled: false, engagementId: 'e', operatorId: 'op' })
    poll('sk-live-abcdefghijklmnop')
    expect(inserted).toHaveLength(0)
  })

  it('on captures a clipboard change', () => {
    configureClipboardMonitor({ enabled: true, engagementId: 'e', operatorId: 'op' })
    const data = poll('hello world')
    expect(data?.subtype).toBe('clipboard_changed')
  })

  it('flipping it back off stops the polling', () => {
    configureClipboardMonitor({ enabled: true, engagementId: 'e', operatorId: 'op' })
    poll('first')
    const seen = inserted.length
    configureClipboardMonitor({ enabled: false })
    poll('second')
    expect(inserted).toHaveLength(seen)
  })

  it('seeds from whatever was already on the clipboard, so opening RedLog does not capture it', () => {
    clipboardText = 'a password from before this session'
    configureClipboardMonitor({ enabled: true, engagementId: 'e', operatorId: 'op' })
    vi.advanceTimersByTime(5000)
    expect(inserted).toHaveLength(0)
  })
})

describe('clipboard.pollMs', () => {
  // `configureClipboardMonitor` merges a partial over the module's current
  // config, so omitting the key (rather than passing undefined) is what "leave
  // it alone" looks like. The first case below therefore reads the module
  // default — keep it first, since the clamp cases after it overwrite the value.
  function intervalFor(opts: { pollMs?: number } = {}): number {
    const spy = vi.spyOn(globalThis, 'setInterval')
    configureClipboardMonitor({ enabled: true, ...opts, engagementId: 'e', operatorId: 'op' })
    const ms = spy.mock.calls[spy.mock.calls.length - 1][1] as number
    spy.mockRestore()
    return ms
  }

  it('defaults to 1500ms', () => {
    expect(intervalFor()).toBe(1500)
  })

  it('honours a slower cadence', () => {
    expect(intervalFor({ pollMs: 5000 })).toBe(5000)
  })

  it('clamps anything under 500ms — a tighter loop is pure CPU burn', () => {
    expect(intervalFor({ pollMs: 50 })).toBe(500)
    expect(intervalFor({ pollMs: 0 })).toBe(500)
  })
})

describe('clipboard.storePreview', () => {
  beforeEach(() => { clipboardText = '' })

  it('off: the event carries hash, length and line count but no text', () => {
    configureClipboardMonitor({ enabled: true, storePreview: false, engagementId: 'e', operatorId: 'op' })
    const data = poll('super secret note\nsecond line')
    expect(data?.preview).toBeNull()
    expect(data?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(data?.length).toBe(29)
    expect(data?.lines).toBe(2)
  })

  it('on: a preview is stored', () => {
    configureClipboardMonitor({ enabled: true, storePreview: true, engagementId: 'e', operatorId: 'op' })
    const data = poll('an ordinary note')
    expect(data?.preview).toBe('an ordinary note')
  })

  it('on: the preview is capped at 120 chars', () => {
    configureClipboardMonitor({ enabled: true, storePreview: true, engagementId: 'e', operatorId: 'op' })
    const data = poll('x'.repeat(500))
    expect((data?.preview as string).length).toBe(120)
    expect(data?.length).toBe(500)   // the true length is still recorded
  })

  it('on: a high-entropy secret inside the preview is masked, never stored raw', () => {
    configureClipboardMonitor({ enabled: true, storePreview: true, engagementId: 'e', operatorId: 'op' })
    const secret = 'AKIA4NNQ7XZL2M8VYTBR9WJC5FDK'
    const data = poll(`aws key ${secret}`)
    expect(data?.preview).not.toContain(secret)
    expect(data?.preview).toContain('•')
    expect(data?.redactionsInPreview).toBeGreaterThan(0)
  })

  it('the raw text never appears in the event, whatever the setting', () => {
    configureClipboardMonitor({ enabled: true, storePreview: false, engagementId: 'e', operatorId: 'op' })
    const secret = 'AKIA4NNQ7XZL2M8VYTBR9WJC5FDK'
    poll(`aws key ${secret}`)
    expect(JSON.stringify(inserted)).not.toContain(secret)
  })
})

describe('clipboard capture gating', () => {
  it('dedupes a repeated read of the same value into one event', () => {
    configureClipboardMonitor({ enabled: true, engagementId: 'e', operatorId: 'op' })
    poll('same')
    poll('same')
    poll('same')
    expect(inserted).toHaveLength(1)
  })

  it('a changed value after a repeat is captured', () => {
    configureClipboardMonitor({ enabled: true, engagementId: 'e', operatorId: 'op' })
    poll('one')
    poll('one')
    poll('two')
    expect(inserted).toHaveLength(2)
  })

  it('an empty clipboard produces nothing', () => {
    configureClipboardMonitor({ enabled: true, engagementId: 'e', operatorId: 'op' })
    poll('')
    expect(inserted).toHaveLength(0)
  })

  it('paused recording suspends ambient clipboard capture', () => {
    configureClipboardMonitor({ enabled: true, engagementId: 'e', operatorId: 'op' })
    eventBus.pause('ui')
    poll('captured while paused?')
    expect(inserted).toHaveLength(0)
    eventBus.resume('ui')
    poll('captured after resume')
    expect(inserted).toHaveLength(1)
  })

  it('records the loot types found without copying the credential onto the event', () => {
    const secret = 'AKIA4NNQ7XZL2M8VYTBR9WJC5FDK'
    configureClipboardMonitor({
      enabled: true,
      engagementId: 'e',
      operatorId: 'op',
      lootDetector: { scan: () => [{ type: 'aws_key' }] } as never
    })
    const data = poll(secret)
    expect(data?.lootTypes).toEqual(['aws_key'])
    expect(JSON.stringify(data)).not.toContain(secret)
  })

  it('a throwing loot detector does not lose the clipboard event', () => {
    configureClipboardMonitor({
      enabled: true,
      engagementId: 'e',
      operatorId: 'op',
      lootDetector: { scan: () => { throw new Error('boom') } } as never
    })
    expect(poll('still recorded')?.subtype).toBe('clipboard_changed')
  })
})
