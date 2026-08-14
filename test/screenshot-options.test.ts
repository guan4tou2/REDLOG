// screenshot.{quality,intervalSec} — the auto-capture cadence and the JPEG
// quality it writes at. intervalSec is the one config number that can quietly
// fill a project directory, and it has three distinct off-switches (0, no
// operator, paused recording), so each one gets an assertion.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let projectDir = ''
const inserted: Array<Record<string, unknown>> = []
const jpegCalls: number[] = []
/** Per-pixel value the fake screen renders at — change it to "move the screen". */
let frame = 10

function fakeImage(): unknown {
  const img: Record<string, unknown> = {
    toJPEG: (q: number) => { jpegCalls.push(q); return Buffer.from(`jpeg-${frame}`) },
    resize: () => ({
      // 9×8 BGRA, every pixel a ramp seeded from `frame` so two different
      // frames are perceptually far apart and two identical ones are not.
      toBitmap: () => Buffer.from(Array.from({ length: 9 * 8 * 4 }, (_, i) => (i * frame) % 256))
    })
  }
  return img
}

vi.mock('electron', () => ({
  screen: { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 } }) },
  desktopCapturer: { getSources: async () => [{ thumbnail: fakeImage() }] }
}))

vi.mock('../src/core/db/index', () => ({ getProjectDir: () => projectDir }))

vi.mock('../src/core/db/events', () => ({
  insertEvent: (type: string, data: Record<string, unknown>) => {
    inserted.push({ type, ...data })
    return { id: `e${inserted.length}`, agentType: type, data }
  }
}))

const { ScreenshotAgent } = await import('../src/main/services/screenshot-agent')
const { eventBus } = await import('../src/core/event-bus')

let agent: InstanceType<typeof ScreenshotAgent>

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-shot-'))
  inserted.length = 0
  jpegCalls.length = 0
  frame = 10
  if (eventBus.paused) eventBus.resume()
  agent = new ScreenshotAgent()
})

afterEach(() => {
  agent.stop()
  fs.rmSync(projectDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('screenshot.intervalSec — periodic auto-capture', () => {
  function scheduledMs(opts: { intervalSec?: number; operatorId?: string }): number | null {
    const spy = vi.spyOn(globalThis, 'setInterval')
    agent.configure({ engagementId: 'e', operatorId: 'op', ...opts })
    const call = spy.mock.calls[spy.mock.calls.length - 1]
    spy.mockRestore()
    return call ? (call[1] as number) : null
  }

  it('0 (the default) schedules nothing', () => {
    expect(scheduledMs({ intervalSec: 0 })).toBeNull()
  })

  it('30 schedules a 30s loop', () => {
    expect(scheduledMs({ intervalSec: 30 })).toBe(30_000)
  })

  it('floors a fractional interval instead of producing a fractional timer', () => {
    expect(scheduledMs({ intervalSec: 12.9 })).toBe(12_000)
  })

  it('treats a negative interval as off', () => {
    expect(scheduledMs({ intervalSec: -5 })).toBeNull()
  })

  it('will not schedule without an operator id — every frame needs attribution', () => {
    const spy = vi.spyOn(globalThis, 'setInterval')
    new ScreenshotAgent().configure({ engagementId: 'e', intervalSec: 30 })
    expect(spy).not.toHaveBeenCalled()
  })

  it('setting it back to 0 cancels the running loop', () => {
    agent.configure({ engagementId: 'e', operatorId: 'op', intervalSec: 30 })
    const clear = vi.spyOn(globalThis, 'clearInterval')
    agent.configure({ intervalSec: 0 })
    expect(clear).toHaveBeenCalled()
  })

  it('re-configuring the interval replaces the old timer rather than stacking one', () => {
    agent.configure({ engagementId: 'e', operatorId: 'op', intervalSec: 30 })
    const clear = vi.spyOn(globalThis, 'clearInterval')
    const set = vi.spyOn(globalThis, 'setInterval')
    agent.configure({ intervalSec: 10 })
    expect(clear).toHaveBeenCalledTimes(1)
    expect(set.mock.calls[set.mock.calls.length - 1][1]).toBe(10_000)
  })
})

describe('screenshot.quality — what reaches the JPEG encoder', () => {
  it('defaults to 85', async () => {
    agent.configure({ engagementId: 'e', operatorId: 'op' })
    await agent.captureNow('manual')
    expect(jpegCalls).toEqual([85])
  })

  it('passes a configured quality straight through', async () => {
    agent.configure({ engagementId: 'e', operatorId: 'op', quality: 40 })
    await agent.captureNow('manual')
    expect(jpegCalls).toEqual([40])
  })

  it('ignores 0 — a zero-quality capture is not evidence', async () => {
    agent.configure({ engagementId: 'e', operatorId: 'op', quality: 0 })
    await agent.captureNow('manual')
    expect(jpegCalls).toEqual([85])
  })
})

describe('captureNow — what lands on disk and in the chain', () => {
  beforeEach(() => agent.configure({ engagementId: 'e', operatorId: 'op' }))

  it('writes the jpeg and records its size, dimensions and digest', async () => {
    const p = await agent.captureNow('manual')
    expect(p).toBeTruthy()
    expect(fs.existsSync(p as string)).toBe(true)
    const ev = inserted[0]
    expect(ev.trigger).toBe('manual')
    expect(ev.width).toBe(1920)
    expect(ev.height).toBe(1080)
    expect(ev.size).toBeGreaterThan(0)
    expect(ev.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('files land under the project screenshots/ directory', async () => {
    const p = await agent.captureNow('manual') as string
    expect(path.dirname(p)).toBe(path.join(projectDir, 'screenshots'))
  })

  it('does nothing at all without an operator id', async () => {
    expect(await new ScreenshotAgent().captureNow('manual')).toBeNull()
    expect(inserted).toHaveLength(0)
  })

  it('links a cause event id when one is supplied', async () => {
    await agent.captureNow('manual', 'marker-1')
    expect(inserted[0]._causes).toEqual(['marker-1'])
  })
})

describe('dedup + pause gating for automatic captures', () => {
  beforeEach(() => agent.configure({ engagementId: 'e', operatorId: 'op' }))

  it('an unchanged screen is captured once, not once per tick', async () => {
    await agent.captureNow('periodic')
    await agent.captureNow('periodic')
    expect(inserted).toHaveLength(1)
  })

  it('a changed screen is captured again', async () => {
    await agent.captureNow('periodic')
    frame = 200
    await agent.captureNow('periodic')
    expect(inserted).toHaveLength(2)
  })

  it('a manual capture always lands, even on an identical screen', async () => {
    await agent.captureNow('manual')
    await agent.captureNow('manual')
    expect(inserted).toHaveLength(2)
  })

  it('paused recording suspends periodic capture', async () => {
    eventBus.pause('ui')
    expect(await agent.captureNow('periodic')).toBeNull()
    expect(inserted).toHaveLength(0)
  })

  it('a manual capture still works while paused — user intent overrides', async () => {
    eventBus.pause('ui')
    expect(await agent.captureNow('manual')).toBeTruthy()
    expect(inserted).toHaveLength(1)
  })
})
