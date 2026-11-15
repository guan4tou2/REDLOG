// Spec 071: a manual capture is the operator's act and carries the selected
// target they hand the agent (`operator-selected`); a timed, idle or
// command-end capture and POST /api/screenshot have no operator act behind them
// and write no target, whatever the options say.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const h = vi.hoisted(() => ({
  events: [] as Array<{ data: Record<string, unknown>; opts: Record<string, unknown> }>,
  dir: ''
}))

const image = (): unknown => {
  const img = {
    toJPEG: () => Buffer.alloc(64, 3),
    toBitmap: () => Buffer.alloc(288, 3),
    isEmpty: () => false,
    getSize: () => ({ width: 100, height: 100 }),
    resize: () => img
  }
  return img
}
vi.mock('electron', () => ({
  screen: {
    getPrimaryDisplay: () => ({ id: 1, size: { width: 100, height: 100 } }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ id: 1, size: { width: 100, height: 100 } }),
    getAllDisplays: () => [{ id: 1 }]
  },
  desktopCapturer: { getSources: async () => [{ display_id: '1', thumbnail: image() }] }
}))
vi.mock('../src/core/ingest', () => ({
  ingestEvent: (_type: string, data: Record<string, unknown>, opts: Record<string, unknown>) => { h.events.push({ data, opts }); return { id: 'e1' } }
}))
vi.mock('../src/core/event-bus', () => ({ eventBus: { paused: false } }))
vi.mock('../src/core/db/index', () => ({ getProjectDir: () => h.dir, dbGeneration: () => 0 }))
vi.mock('../src/core/capture-health', () => ({ noteCaptureError: () => {}, clearCaptureError: () => {}, noteDbError: () => {} }))

import { ScreenshotAgent } from '../src/main/services/screenshot-agent'

describe('a capture\'s target', () => {
  let agent: ScreenshotAgent
  beforeEach(() => {
    h.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-shot-via-'))
    h.events = []
    agent = new ScreenshotAgent()
    agent.configure({ identity: { projectId: 'proj', engagementId: 'eng', operatorId: 'op' } })
  })
  afterEach(() => fs.rmSync(h.dir, { recursive: true, force: true }))

  it('a manual capture writes the target it was handed, as operator-selected', async () => {
    await agent.captureNow('manual', undefined, { targetId: '10.10.11.24' })
    expect(h.events[0].opts).toMatchObject({ targetId: '10.10.11.24', targetVia: 'operator-selected' })
  })

  it('a manual capture handed no target writes none', async () => {
    await agent.captureNow('manual', undefined, {})
    expect(h.events[0].opts.targetId).toBeUndefined()
    expect(h.events[0].opts.targetVia).toBeUndefined()
  })

  it.each(['periodic', 'idle', 'command', 'api'])('a %s capture writes none, even when handed a target', async (trigger) => {
    await agent.captureNow(trigger, undefined, { targetId: '10.10.11.24' })
    expect(h.events).toHaveLength(1)
    expect(h.events[0].opts.targetId).toBeUndefined()
    expect(h.events[0].opts.targetVia).toBeUndefined()
  })
})
