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
  ingest: 'ok' as 'ok' | 'null' | 'throw',
  dir: '',
  generation: 0,
  switchDuringGrab: false
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
    getPrimaryDisplay: () => ({ id: 1, size: { width: 1920, height: 1080 } }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ id: 1, size: { width: 1920, height: 1080 } }),
    getAllDisplays: () => [{}, {}]
  },
  desktopCapturer: {
    getSources: async () => {
      // A project switch landing while the screen is being grabbed.
      if (h.switchDuringGrab) h.generation++
      return Array.from({ length: h.sources }, () => ({ thumbnail: fakeImage }))
    }
  }
}))
vi.mock('../src/core/ingest', () => ({
  ingestEvent: (type: string, data: Record<string, unknown>) => {
    if (h.ingest === 'throw') throw new Error('database is locked')
    if (h.ingest === 'null') return null
    h.events.push({ type, data })
    return { id: 'e1' }
  }
}))
vi.mock('../src/core/event-bus', () => ({ eventBus: { paused: false } }))
vi.mock('../src/core/db/index', () => ({ getProjectDir: () => h.dir, dbGeneration: () => h.generation }))
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
    h.jpegBytes = 0; h.empty = true; h.sources = 1; h.ingest = 'ok'
    h.generation = 0; h.switchDuringGrab = false
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

  it('records nothing when the project changed while the screen was grabbed', async () => {
    // The frame is the previous project's; written now it would land in the
    // next one, linked to an event that is not there.
    h.jpegBytes = 4096; h.empty = false; h.switchDuringGrab = true
    expect(await agent().captureNow('command', 'event-in-previous-project')).toBeNull()
    expect(shots()).toEqual([])
    expect(h.events).toEqual([])
  })

  it('still records a real frame', async () => {
    h.jpegBytes = 4096; h.empty = false
    const result = await agent().captureNow('manual')
    expect(result).not.toBeNull()
    expect(shots()).toHaveLength(1)
    expect(h.events).toHaveLength(1)
    expect(h.events[0].data.size).toBe(4096)
  })

  // The frame was real, but nothing recorded it. A picture no event points at
  // is a file the project cannot account for, and "saved" must not be reported.
  it('leaves no file behind, and reports no save, when the event is not recorded', async () => {
    h.jpegBytes = 4096; h.empty = false; h.ingest = 'null'
    const result = await agent().captureNow('manual')
    expect(result).toBeNull()
    expect(shots()).toEqual([])
    expect(h.captureErrors.map((e) => e.message).join(' ')).toMatch(/not recorded/)
    expect(h.dbErrors).toEqual([])
  })

  it('leaves no file behind when recording the event throws', async () => {
    h.jpegBytes = 4096; h.empty = false; h.ingest = 'throw'
    const result = await agent().captureNow('manual')
    expect(result).toBeNull()
    expect(shots()).toEqual([])
    expect(h.captureErrors.map((e) => e.message).join(' ')).toMatch(/database is locked/)
  })

  // POST /api/screenshot is an operator (or their agent) asking for THIS
  // frame. It used to run as an ambient trigger, so perceptual dedup could
  // drop it and return `captured: false` with no reason.
  it('treats an api capture as deliberate, so a repeat of the same screen still lands', async () => {
    h.jpegBytes = 4096; h.empty = false
    const a = agent()
    a.configure({ diffThreshold: 5 })
    const first = await a.captureNow('api')
    const second = await a.captureNow('api')
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    // Two frames, two files. They used to collide whenever both landed in the
    // same millisecond - which is most of the time - and the second silently
    // overwrote the first.
    expect(second).not.toBe(first)
    expect(shots()).toHaveLength(2)

    // An ambient trigger on the same unchanged screen is still deduped away.
    expect(await a.captureNow('periodic')).toBeNull()
    expect(shots()).toHaveLength(2)
  })
})
