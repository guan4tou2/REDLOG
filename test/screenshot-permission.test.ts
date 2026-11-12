import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { CapturePrerequisite } from '../src/core/capture-health'

// #688: without macOS Screen Recording permission desktopCapturer still hands
// back a frame — the wallpaper, every window missing. Stored, it reads as a
// screenshot of the engagement and is not one.

const h = vi.hoisted(() => ({
  grabs: 0,
  events: [] as unknown[],
  captureErrors: [] as Array<{ source: string; message: string }>,
  dir: ''
}))

const wallpaper = {
  toJPEG: () => Buffer.alloc(4096, 1),
  toBitmap: () => Buffer.alloc(288, 1),
  isEmpty: () => false,
  getSize: () => ({ width: 1920, height: 1080 }),
  resize: () => wallpaper
}

vi.mock('electron', () => ({
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ id: 1, size: { width: 1920, height: 1080 } }),
    getAllDisplays: () => [{}]
  },
  desktopCapturer: { getSources: async () => { h.grabs++; return [{ thumbnail: wallpaper, display_id: '1' }] } }
}))
vi.mock('../src/core/ingest', () => ({ ingestEvent: (_t: string, data: unknown) => { h.events.push(data); return { id: 'e1' } } }))
vi.mock('../src/core/event-bus', () => ({ eventBus: { paused: false } }))
vi.mock('../src/core/db/index', () => ({ getProjectDir: () => h.dir, dbGeneration: () => 0 }))
vi.mock('../src/core/capture-health', () => ({
  noteCaptureError: (source: string, e: unknown) =>
    h.captureErrors.push({ source, message: e instanceof Error ? e.message : String(e) }),
  clearCaptureError: () => {},
  noteDbError: () => {},
  configureCapturePrerequisites: () => {}
}))

const { ScreenshotAgent } = await import('../src/main/services/screenshot-agent')

const shots = (): string[] => {
  const d = path.join(h.dir, 'screenshots')
  return fs.existsSync(d) ? fs.readdirSync(d) : []
}
const agent = (state: CapturePrerequisite['state']): InstanceType<typeof ScreenshotAgent> => {
  const a = new ScreenshotAgent(() => ({ id: 'screen-recording', state }))
  a.configure({ identity: { projectId: 'p', engagementId: 'e', operatorId: 'op' } })
  return a
}

describe('screenshot agent and Screen Recording permission', () => {
  beforeEach(() => {
    h.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-shot-perm-'))
    h.grabs = 0; h.events = []; h.captureErrors = []
  })
  afterEach(() => { fs.rmSync(h.dir, { recursive: true, force: true }) })

  it('writes no file and no event when permission is missing, and says why on the source', async () => {
    expect(await agent('missing').captureNow('manual')).toBeNull()
    expect(shots()).toEqual([])
    expect(h.events).toEqual([])
    expect(h.grabs).toBe(0)
    expect(h.captureErrors).toEqual([{ source: 'screenshot', message: expect.stringMatching(/Screen Recording/) }])
  })

  it('does not hold a frame for a marker either', async () => {
    expect(await agent('missing').holdFrame()).toBeNull()
    expect(h.grabs).toBe(0)
  })

  it('still captures when granted or unknown (not yet asked)', async () => {
    for (const state of ['granted', 'unknown'] as const) {
      expect(await agent(state).captureNow('manual')).not.toBeNull()
    }
    expect(shots()).toHaveLength(2)
    expect(h.captureErrors).toEqual([])
  })
})
