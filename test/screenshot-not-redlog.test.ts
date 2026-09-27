// UI/UX audit F2: a capture asked for from inside RedLog must not be a
// picture of RedLog. The marker shortcut holds the frame from before RedLog
// came forward; in-app captures hide RedLog's windows for the grab; and the
// display captured is the one the operator is working on.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const h = vi.hoisted(() => ({
  pixels: 1,
  cursorDisplay: 2,
  events: [] as Array<{ type: string; data: Record<string, unknown> }>,
  dir: ''
}))

const imageOf = (byte: number): unknown => {
  const img = {
    toJPEG: () => Buffer.alloc(64, byte),
    toBitmap: () => Buffer.alloc(288, byte),
    isEmpty: () => false,
    getSize: () => ({ width: 100, height: 100 }),
    resize: () => img
  }
  return img
}

vi.mock('electron', () => ({
  screen: {
    getPrimaryDisplay: () => ({ id: 1, size: { width: 100, height: 100 } }),
    getCursorScreenPoint: () => ({ x: 5000, y: 0 }),
    getDisplayNearestPoint: () => ({ id: h.cursorDisplay, size: { width: 100, height: 100 } }),
    getAllDisplays: () => [{ id: 1 }, { id: 2 }]
  },
  desktopCapturer: {
    // Each display's source shows a different picture: its id times ten, plus
    // whatever `h.pixels` says is on screen right now.
    getSources: async () => [1, 2].map((id) => ({ display_id: String(id), thumbnail: imageOf(id * 10 + h.pixels) }))
  }
}))
vi.mock('../src/core/ingest', () => ({
  ingestEvent: (type: string, data: Record<string, unknown>) => { h.events.push({ type, data }); return { id: 'e1' } }
}))
vi.mock('../src/core/event-bus', () => ({ eventBus: { paused: false } }))
vi.mock('../src/core/db/index', () => ({ getProjectDir: () => h.dir }))
vi.mock('../src/core/capture-health', () => ({ noteCaptureError: () => {}, clearCaptureError: () => {}, noteDbError: () => {} }))

import { ScreenshotAgent } from '../src/main/services/screenshot-agent'

const writtenByte = (): number => {
  const d = path.join(h.dir, 'screenshots')
  const f = fs.readdirSync(d)[0]
  return fs.readFileSync(path.join(d, f))[0]
}

describe('in-app captures do not photograph RedLog', () => {
  let agent: ScreenshotAgent
  beforeEach(() => {
    h.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-shot2-'))
    h.events = []; h.pixels = 1; h.cursorDisplay = 2
    agent = new ScreenshotAgent()
    agent.configure({ engagementId: 'eng', operatorId: 'op' })
  })
  afterEach(() => fs.rmSync(h.dir, { recursive: true, force: true }))

  it('captures the display under the cursor, not always the primary one', async () => {
    await agent.captureNow('manual')
    expect(writtenByte()).toBe(21)
    expect(h.events[0].data.display_id).toBe('2')
  })

  it('uses the frame held when the shortcut fired, and says when it was taken', async () => {
    const token = await agent.holdFrame()
    expect(token).toBeTruthy()
    // RedLog comes forward: the screen now shows something else.
    h.pixels = 7
    await agent.captureNow('manual', 'marker-1', { heldFrame: token!, hideOwnWindows: true })
    expect(writtenByte()).toBe(21)
    expect(h.events[0].data).toMatchObject({ held_for_marker: true, _causes: ['marker-1'] })
    expect(typeof h.events[0].data.captured_at).toBe('number')
  })

  it('writes nothing for a held frame nobody claims, and a token works once', async () => {
    const token = await agent.holdFrame()
    expect(fs.existsSync(path.join(h.dir, 'screenshots'))).toBe(false)
    h.pixels = 3
    await agent.captureNow('manual', undefined, { heldFrame: 'someone-else' })
    expect(writtenByte()).toBe(23)
    // The held frame was not claimed by the wrong token; it still is the only
    // thing its own token can take — and only once.
    await agent.captureNow('manual', undefined, { heldFrame: token! })
    await agent.captureNow('manual', undefined, { heldFrame: token! })
    expect(h.events.filter((e) => e.data.held_for_marker)).toHaveLength(1)
  })

  it('hides RedLog for the grab and brings it back', async () => {
    const order: string[] = []
    agent.setWindowHider(async () => { order.push('hide'); return () => order.push('restore') })
    await agent.captureNow('manual', undefined, { hideOwnWindows: true })
    expect(order).toEqual(['hide', 'restore'])
    // Automatic captures never hide the app.
    await agent.captureNow('periodic')
    expect(order).toEqual(['hide', 'restore'])
  })
})
