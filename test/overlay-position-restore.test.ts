import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'

// §8: the HUD remembers where it sat on each display. It used to look only at
// the primary display's entry, so an operator who keeps it on an external
// monitor got the default position on every launch.

const env = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require('path') as typeof import('path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const f = require('fs') as typeof import('fs')
  return {
    home: f.mkdtempSync(p.join(os.tmpdir(), 'redlog-hudpos-')),
    displays: [] as Array<{ id: number; workArea: { x: number; y: number; width: number; height: number } }>,
    primaryId: 1
  }
})

vi.mock('os', async (importOriginal) => {
  const real = await importOriginal<typeof import('os')>()
  return { ...real, default: { ...real, homedir: () => env.home }, homedir: () => env.home }
})
vi.mock('electron', () => ({
  screen: {
    getAllDisplays: () => env.displays,
    getPrimaryDisplay: () => env.displays.find((d) => d.id === env.primaryId) ?? env.displays[0],
    getDisplayNearestPoint: (pt: { x: number; y: number }) =>
      env.displays.find((d) => pt.x >= d.workArea.x && pt.x < d.workArea.x + d.workArea.width) ?? env.displays[0]
  }
}))

import { loadOverlayPosition, saveOverlayPosition } from '../src/main/services/overlay-position'

const FILE = path.join(env.home, '.redlog', 'overlay-position.json')
const laptop = { id: 1, workArea: { x: 0, y: 25, width: 1728, height: 1092 } }
const external = { id: 2, workArea: { x: 1728, y: 0, width: 2560, height: 1415 } }
const write = (data: unknown): void => {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(data))
}

describe('HUD position restore', () => {
  beforeEach(() => {
    fs.rmSync(path.join(env.home, '.redlog'), { recursive: true, force: true })
    env.displays = [laptop, external]
    env.primaryId = 1
  })
  afterAll(() => fs.rmSync(env.home, { recursive: true, force: true }))

  it('restores the position on a non-primary display that is still attached', () => {
    write({ 1: { x: 900, y: 30, at: 100 }, 2: { x: 3000, y: 10, at: 200 } })
    expect(loadOverlayPosition()).toEqual({ x: 3000, y: 10 })
  })

  it('ignores the entry for a display that is gone', () => {
    write({ 1: { x: 900, y: 30, at: 100 }, 2: { x: 3000, y: 10, at: 200 } })
    env.displays = [laptop]
    expect(loadOverlayPosition()).toEqual({ x: 900, y: 30 })
  })

  it('returns nothing when the only remembered display is gone', () => {
    write({ 2: { x: 3000, y: 10, at: 200 } })
    env.displays = [laptop]
    expect(loadOverlayPosition()).toBeNull()
  })

  it('skips a saved point that is no longer on its display', () => {
    write({ 1: { x: 900, y: 30, at: 100 }, 2: { x: 9000, y: 10, at: 200 } })
    expect(loadOverlayPosition()).toEqual({ x: 900, y: 30 })
  })

  it('prefers the primary display between entries saved before times were kept', () => {
    write({ 2: { x: 3000, y: 10 }, 1: { x: 900, y: 30 } })
    expect(loadOverlayPosition()).toEqual({ x: 900, y: 30 })
  })

  it('stamps a saved position, so the most recent one wins on the next launch', () => {
    write({ 1: { x: 900, y: 30, at: Date.now() - 1000 } })
    saveOverlayPosition({ isDestroyed: () => false, getBounds: () => ({ x: 2000, y: 40, width: 440, height: 80 }) } as never)
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf-8'))
    expect(typeof saved['2'].at).toBe('number')
    expect(loadOverlayPosition()).toEqual({ x: 2000, y: 40 })
  })
})
