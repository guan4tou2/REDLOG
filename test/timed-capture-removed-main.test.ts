import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { DEFAULT_CONFIG, loadConfig, prepareOpenConfig } from '../src/core/config'

// Ruling 7 (2026-11-12, carried out 2026-11-18): main takes no screenshot on
// a timer or when a command ends, and does not look for an update on its own.
// The migration rule above the ruling's table: a config key is ignored when
// read and never deleted from the operator's file.

const h = vi.hoisted(() => ({ events: [] as Array<{ type: string; data: Record<string, unknown> }>, dir: '' }))
const image = {
  toJPEG: () => Buffer.alloc(2048, 7), toBitmap: () => Buffer.alloc(288, 1), isEmpty: () => false,
  getSize: () => ({ width: 1920, height: 1080 }), resize: () => image
}
vi.mock('electron', () => ({
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ id: 1, size: { width: 1920, height: 1080 } }),
    getAllDisplays: () => [{}]
  },
  desktopCapturer: { getSources: async () => [{ thumbnail: image, display_id: '1' }] }
}))
vi.mock('../src/core/ingest', () => ({
  ingestEvent: (type: string, data: Record<string, unknown>) => { h.events.push({ type, data }); return { id: `e${h.events.length}` } }
}))
vi.mock('../src/core/event-bus', () => ({ eventBus: { paused: false } }))
vi.mock('../src/core/db/index', () => ({ getProjectDir: () => h.dir, dbGeneration: () => 0 }))
vi.mock('../src/core/capture-health', () => ({ noteCaptureError: () => {}, clearCaptureError: () => {}, noteDbError: () => {} }))
vi.mock('../src/main/services/capture-prerequisites', () => ({ currentScreenRecording: () => ({ state: 'granted' }) }))

const ROOT = path.join(__dirname, '..')
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8')

describe('no timed or on-command screenshots', () => {
  beforeEach(() => { h.events = []; h.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-r7-')) })
  afterEach(() => { vi.useRealTimers(); fs.rmSync(h.dir, { recursive: true, force: true }) })

  it('starts no timer when handed the old interval, and has no command-end hook', async () => {
    vi.useFakeTimers()
    const { ScreenshotAgent } = await import('../src/main/services/screenshot-agent')
    const agent = new ScreenshotAgent()
    agent.configure({ identity: { projectId: 'p', engagementId: 'e', operatorId: 'op' }, quality: 80, intervalSec: 1, captureOnCommand: true } as never)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.events).toEqual([])
    expect('onCommandEnd' in agent).toBe(false)
    vi.useRealTimers()
    // A manual capture still lands.
    expect(await agent.captureNow('manual')).not.toBeNull()
    expect(h.events.map((e) => e.data.trigger)).toEqual(['manual'])
  })

  it('main no longer calls the agent when a command ends', () => {
    expect(read('src/main/index.ts')).not.toMatch(/onCommandEnd/)
  })
})

describe('an old project file with the removed keys', () => {
  let dir = ''
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-r7cfg-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('loads without error, and an open writes the keys back untouched', () => {
    fs.writeFileSync(path.join(dir, 'config.yaml'),
      'engagement:\n  id: old\nscreenshot:\n  quality: 70\n  intervalSec: 300\n  diffThreshold: 12\n  captureOnCommand: true\n')
    expect(loadConfig(dir).screenshot.quality).toBe(70)
    prepareOpenConfig(dir)
    const back = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')
    expect(back).toMatch(/intervalSec: 300/)
    expect(back).toMatch(/diffThreshold: 12/)
    expect(back).toMatch(/captureOnCommand: true/)
  })

  it('a new project gets none of them', () => {
    expect(Object.keys(DEFAULT_CONFIG.screenshot)).toEqual(['quality'])
  })
})

describe('the update check runs only when pressed', () => {
  it('main schedules no check at launch and has no switch for one', () => {
    const index = read('src/main/index.ts')
    // The only call: the About button's IPC.
    expect(index.match(/checkForUpdates\(/g)).toHaveLength(1)
    expect(index).toMatch(/ipcMain\.handle\('app:checkForUpdates', \(\) => checkForUpdates\(\{ manual: true \}\)\)/)
    expect(index).not.toMatch(/app:setAutoUpdateCheck|autoCheckEnabled/)
    expect(read('src/preload/index.ts')).not.toMatch(/setAutoUpdateCheck/)
  })
})
