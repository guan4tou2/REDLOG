import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// A screenshot that captured nothing must not become evidence.
//
// Windows 11 / Chromium 152 returns the right number of screen sources with
// every thumbnail empty — 0x0, `isEmpty()` true, `toJPEG()` zero bytes, at
// every requested size. Nothing downstream noticed, because the sha256 of
// zero bytes is a perfectly good hash: the agent wrote a 0-byte .jpg,
// ingested a screenshot event for it, the Screenshots grid showed it as a
// captured frame, and the export carried it into the evidence bundle where
// the verifier confirmed its digest and called it verified.

const h = vi.hoisted(() => ({
  jpegBytes: 0,
  empty: true,
  sources: 1,
  events: [] as Array<{ type: string; data: Record<string, unknown> }>,
  captureErrors: [] as Array<{ source: string; message: string }>,
  dbErrors: [] as string[],
  dir: ''
}))

const fakeImage = {
  toJPEG: () => Buffer.alloc(h.jpegBytes, 1),
  toBitmap: () => Buffer.alloc(h.empty ? 0 : 288, 1),
  isEmpty: () => h.empty,
  getSize: () => (h.empty ? { width: 0, height: 0 } : { width: 1920, height: 1080 }),
  resize: () => fakeImage
}

vi.mock('electron', () => ({
  screen: {
    getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 } }),
    getAllDisplays: () => [{}, {}]
  },
  desktopCapturer: {
    getSources: async () => Array.from({ length: h.sources }, () => ({ thumbnail: fakeImage }))
  }
}))
vi.mock('../src/core/ingest', () => ({
  ingestEvent: (type: string, data: Record<string, unknown>) => { h.events.push({ type, data }); return { id: 'e1' } }
}))
vi.mock('../src/core/event-bus', () => ({ eventBus: { paused: false } }))
vi.mock('../src/core/db/index', () => ({ getProjectDir: () => h.dir }))
vi.mock('../src/core/capture-health', () => ({
  noteCaptureError: (source: string, e: unknown) =>
    h.captureErrors.push({ source, message: e instanceof Error ? e.message : String(e) }),
  clearCaptureError: () => {},
  noteDbError: (source: string) => { h.dbErrors.push(source) }
}))

let ScreenshotAgent: typeof import('../src/main/services/screenshot-agent').ScreenshotAgent

const shots = (): string[] => {
  const d = path.join(h.dir, 'screenshots')
  return fs.existsSync(d) ? fs.readdirSync(d) : []
}

describe('the screenshot agent refuses to record an empty frame', () => {
  beforeEach(async () => {
    ScreenshotAgent = (await import('../src/main/services/screenshot-agent')).ScreenshotAgent
    h.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-shot-'))
    h.events = []; h.captureErrors = []; h.dbErrors = []
    h.jpegBytes = 0; h.empty = true; h.sources = 1
  })
  afterEach(() => { fs.rmSync(h.dir, { recursive: true, force: true }) })

  const agent = (): InstanceType<typeof ScreenshotAgent> => {
    const a = new ScreenshotAgent()
    a.configure({ engagementId: 'eng', operatorId: 'op' })
    return a
  }

  it('writes no file and records no event when the frame comes back empty', async () => {
    const result = await agent().captureNow('manual')
    expect(result).toBeNull()
    expect(shots()).toEqual([])
    expect(h.events).toEqual([])
  })

  it('says why, on the source, without claiming the database is broken', async () => {
    await agent().captureNow('api')
    expect(h.captureErrors).toHaveLength(1)
    expect(h.captureErrors[0].source).toBe('screenshot')
    expect(h.captureErrors[0].message).toMatch(/empty/)
    // `noteDbError` means evidence cannot be written at all and takes the
    // whole verdict dark. A blind camera is not that.
    expect(h.dbErrors).toEqual([])
  })

  it('still records a real frame', async () => {
    h.jpegBytes = 4096; h.empty = false
    const result = await agent().captureNow('manual')
    expect(result).not.toBeNull()
    expect(shots()).toHaveLength(1)
    expect(h.events).toHaveLength(1)
    expect(h.events[0].data.size).toBe(4096)
  })

  // POST /api/screenshot is an operator (or their agent) asking for THIS
  // frame. It used to run as an ambient trigger, so perceptual dedup could
  // drop it and return `captured: false` with no reason.
  it('treats an api capture as deliberate, so a repeat of the same screen still lands', async () => {
    h.jpegBytes = 4096; h.empty = false
    const a = agent()
    a.configure({ diffThreshold: 5 })
    expect(await a.captureNow('api')).not.toBeNull()
    expect(await a.captureNow('api')).not.toBeNull()
    expect(shots()).toHaveLength(2)

    // An ambient trigger on the same unchanged screen is still deduped away.
    expect(await a.captureNow('periodic')).toBeNull()
    expect(shots()).toHaveLength(2)
  })
})
