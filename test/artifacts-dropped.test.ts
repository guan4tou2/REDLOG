// UI/UX audit F8: files dropped on the window become evidence, but only after
// the main process has listed them and the operator agreed. A path handed in
// by the renderer is never read on its word alone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const h = vi.hoisted(() => ({ answer: 0, asked: [] as Array<{ detail: string }> }))
vi.mock('electron', () => ({
  dialog: {
    showMessageBox: vi.fn(async (_w: unknown, opts: { detail: string }) => { h.asked.push(opts); return { response: h.answer } }),
    showOpenDialog: vi.fn()
  }
}))

import { initDB, closeDB } from '../src/core/db/index'
import { _resetIngest } from '../src/core/ingest'
import { registerArtifactsIpc } from '../src/main/ipc/artifacts'
import type { IpcContext } from '../src/main/ipc/types'

type Handler = (_e: unknown, ...args: unknown[]) => Promise<unknown>

describe('dropping files as evidence', () => {
  let dir: string
  let loot: string
  let handlers: Map<string, Handler>
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-drop-'))
    loot = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-loot-'))
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'engagement:\n  id: eng-1\noperator:\n  id: op-1\n')
    fs.writeFileSync(path.join(loot, 'hashes.txt'), 'admin:aad3b435')
    initDB(dir)
    _resetIngest()
    h.asked = []; h.answer = 0
    handlers = new Map()
    const ctx = {
      getActiveProject: () => ({ id: 'eng-1', name: 'T', path: dir, createdAt: 1, lastOpened: 1 }),
      getMainWindow: () => ({})
    } as unknown as IpcContext
    registerArtifactsIpc({ handle: (n: string, fn: Handler) => handlers.set(n, fn) } as never, ctx)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(loot, { recursive: true, force: true })
  })

  const drop = (paths: unknown): Promise<unknown> =>
    handlers.get('artifacts:addDropped')!({}, paths, { title: 't', message: 'm', confirm: 'y', cancel: 'n' })

  it('lists every file for the operator, and copies nothing when they decline', async () => {
    h.answer = 1
    const file = path.join(loot, 'hashes.txt')
    expect(await drop([file])).toEqual({ canceled: true, results: [] })
    expect(h.asked[0].detail).toBe(file)
    expect(fs.existsSync(path.join(dir, 'artifacts'))).toBe(false)
  })

  it('adds the files once confirmed', async () => {
    const r = await drop([path.join(loot, 'hashes.txt')]) as { results: Array<{ ok: boolean; eventId: string | null }> }
    expect(r.results[0]).toMatchObject({ ok: true })
    expect(r.results[0].eventId).toBeTruthy()
    expect(fs.readdirSync(path.join(dir, 'artifacts'))).toHaveLength(1)
  })

  it('ignores anything that is not an absolute path, without asking', async () => {
    expect(await drop(['relative/file', 42, null])).toEqual({ canceled: true, results: [] })
    expect(await drop('not-an-array')).toEqual({ canceled: true, results: [] })
    expect(h.asked).toHaveLength(0)
  })
})
