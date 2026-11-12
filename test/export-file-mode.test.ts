import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const { showOpenDialog } = vi.hoisted(() => ({ showOpenDialog: vi.fn() }))
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() }, dialog: { showOpenDialog } }))

import { initDB, closeDB } from '../src/core/db/index'
import { RecentExportStore } from '../src/main/services/recent-export'
import { registerDataExportIpc } from '../src/main/ipc/data-export'
import type { IpcContext } from '../src/main/ipc/types'
import type { ProjectMeta } from '../src/core/project-manager'
import { ExportPlanRegistry } from '../src/core/export-plan'
import { addExportEvent as addEvent } from './helpers/export-fixtures'

type Handler = (_event: unknown, input?: never) => unknown | Promise<unknown>

describe.skipIf(process.platform === 'win32')('export file modes', () => {
  let dir: string
  let out: string
  const handlers = new Map<string, Handler>()
  let seq = 0
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-mode-'))
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-mode-out-'))
    initDB(dir)
    const active: ProjectMeta = { id: 'eng-1', name: 'Test', path: dir, createdAt: 1, lastOpened: 1 }
    const ctx = {
      getActiveProject: () => active, getMainWindow: () => null, getOverlayWindow: () => null,
      getCurrentEngagementId: () => active.id, getCurrentOperatorId: () => null, send: () => undefined
    } as unknown as IpcContext
    registerDataExportIpc({ handle: (n: string, fn: Handler) => { handlers.set(n, fn) } } as never, ctx,
      { planRegistry: new ExportPlanRegistry(), recentExports: new RecentExportStore(path.join(dir, 'machine-data')) })
  })
  afterEach(() => { closeDB(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }) })

  it.each(['json', 'ndjson', 'har'])('%s export and its manifest are owner-only even under a permissive umask', async (format) => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [out] })
    await handlers.get('data:pickExportDir')?.({})
    addEvent('events', `m${++seq}`, 1000 + seq)
    const plan = await handlers.get('data:resolveExportPlan')?.({}, { format } as never) as { ok: boolean; plan: { id: string } }
    expect(plan.ok, JSON.stringify(plan)).toBe(true)
    const old = process.umask(0o000)
    let done: { ok: boolean; artifactPath: string }
    try {
      done = await handlers.get('data:executeExportPlan')?.({}, { planId: plan.plan.id, destDir: out } as never) as typeof done
    } finally { process.umask(old) }
    expect(done.ok).toBe(true)
    expect(fs.statSync(done.artifactPath).mode & 0o777).toBe(0o600)
    expect(fs.statSync(done.artifactPath + '.manifest.json').mode & 0o777).toBe(0o600)
  })
})
