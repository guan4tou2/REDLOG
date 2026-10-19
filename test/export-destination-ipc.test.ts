import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const { showOpenDialog } = vi.hoisted(() => ({ showOpenDialog: vi.fn() }))
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() }, dialog: { showOpenDialog } }))

import { initDB, closeDB } from '../src/core/db/index'
import { registerDataExportIpc } from '../src/main/ipc/data-export'
import type { IpcContext } from '../src/main/ipc/types'
import type { ProjectMeta } from '../src/core/project-manager'
import { ExportPlanRegistry } from '../src/core/export-plan'
import { defaultExportDir, resolveExportDestination } from '../src/core/export-destination'
import { addExportEvent as addEvent } from './helpers/export-fixtures'

type Handler = (_event: unknown, input?: never) => unknown | Promise<unknown>

describe('resolveExportDestination', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-dest-')) })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('defaults to the project exports folder', () => {
    expect(resolveExportDestination(tmp, undefined, new Set())).toEqual({ ok: true, dir: defaultExportDir(tmp), custom: false })
  })
  it('accepts a folder only if main approved it', () => {
    const picked = path.join(tmp, 'picked')
    fs.mkdirSync(picked)
    expect(resolveExportDestination(tmp, picked, new Set())).toEqual({ ok: false, error: 'invalid-destination' })
    expect(resolveExportDestination(tmp, picked, new Set([path.resolve(picked)]))).toEqual({ ok: true, dir: path.resolve(picked), custom: true })
  })
  it('refuses a non-string, a missing folder and a file', () => {
    const file = path.join(tmp, 'f')
    fs.writeFileSync(file, '')
    const approved = new Set([path.resolve(file), path.join(tmp, 'gone')])
    for (const bad of [42, {}, file, path.join(tmp, 'gone')]) {
      expect(resolveExportDestination(tmp, bad, approved)).toEqual({ ok: false, error: 'invalid-destination' })
    }
  })
})

describe('export destination IPC', () => {
  let dir: string
  let out: string
  let active: ProjectMeta
  let handlers: Map<string, Handler>

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-dest-ipc-'))
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-dest-out-'))
    initDB(dir)
    active = { id: 'eng-1', name: 'Test', path: dir, createdAt: 1, lastOpened: 1 }
    handlers = new Map()
    showOpenDialog.mockReset()
    const ipcMain = { handle: (name: string, fn: Handler) => { handlers.set(name, fn) } }
    const ctx = {
      getActiveProject: () => active, getMainWindow: () => null, getOverlayWindow: () => null,
      getCurrentEngagementId: () => active.id, getCurrentOperatorId: () => null, send: () => undefined
    } as unknown as IpcContext
    registerDataExportIpc(ipcMain as never, ctx, { planRegistry: new ExportPlanRegistry() })
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(out, { recursive: true, force: true })
  })

  let seq = 0
  const resolvePlan = (format: string): string => {
    addEvent('events', `e${++seq}`, 1000 + seq)
    const r = handlers.get('data:resolveExportPlan')?.({}, { format } as never) as { ok: true; plan: { id: string } }
    expect(r.ok).toBe(true)
    return r.plan.id
  }

  it('reports the default folder', async () => {
    expect(await handlers.get('data:exportDestination')?.({})).toBe(path.join(dir, 'exports'))
  })

  it('writes to a folder picked in the dialog, for json, ndjson and har', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [out] })
    expect(await handlers.get('data:pickExportDir')?.({})).toBe(path.resolve(out))
    for (const [format, ext] of [['json', '.json'], ['ndjson', '.ndjson'], ['har', '.har']]) {
      const executed = await handlers.get('data:executeExportPlan')?.({}, { planId: resolvePlan(format), destDir: out } as never) as { ok: true; artifactPath: string }
      expect(executed.ok).toBe(true)
      expect(path.dirname(executed.artifactPath)).toBe(path.resolve(out))
      expect(executed.artifactPath.endsWith(ext)).toBe(true)
      expect(fs.existsSync(executed.artifactPath)).toBe(true)
    }
    expect(fs.existsSync(path.join(dir, 'exports'))).toBe(false)
  })

  it('also honours the folder for the evidence bundle and a timeline slice', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [out] })
    await handlers.get('data:pickExportDir')?.({})
    for (const format of ['bundle', 'timeline']) {
      const executed = await handlers.get('data:executeExportPlan')?.({}, { planId: resolvePlan(format), destDir: out } as never) as { ok: boolean; artifactPath: string; error?: string }
      expect(executed.ok, executed.error).toBe(true)
      expect(path.dirname(executed.artifactPath)).toBe(path.resolve(out))
    }
  })

  it('refuses a folder the dialog never returned, and does not spend the plan', async () => {
    const planId = resolvePlan('json')
    expect(await handlers.get('data:executeExportPlan')?.({}, { planId, destDir: out } as never)).toEqual({ ok: false, error: 'invalid-destination' })
    expect(fs.readdirSync(out)).toEqual([])
    const retry = await handlers.get('data:executeExportPlan')?.({}, { planId } as never) as { ok: boolean; artifactPath?: string }
    expect(retry.ok).toBe(true)
    expect(path.dirname(retry.artifactPath!)).toBe(path.join(dir, 'exports'))
  })

  it('a cancelled picker approves nothing', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await handlers.get('data:pickExportDir')?.({})).toBeNull()
    const executed = await handlers.get('data:executeExportPlan')?.({}, { planId: resolvePlan('json'), destDir: out } as never)
    expect(executed).toEqual({ ok: false, error: 'invalid-destination' })
  })

  it('can reveal a file in a picked folder but not an arbitrary one', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [out] })
    await handlers.get('data:pickExportDir')?.({})
    const inPicked = path.join(out, 'x.json'); fs.writeFileSync(inPicked, '{}')
    const elsewhere = path.join(os.tmpdir(), `redlog-elsewhere-${Date.now()}.json`); fs.writeFileSync(elsewhere, '{}')
    try {
      expect(await handlers.get('data:revealExport')?.({}, inPicked as never)).toBe(true)
      expect(await handlers.get('data:revealExport')?.({}, elsewhere as never)).toBe(false)
    } finally { fs.rmSync(elsewhere, { force: true }) }
  })
})
