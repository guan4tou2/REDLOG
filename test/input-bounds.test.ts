import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Bounds a probe found missing: a 1 MiB marker title stored as is, a URL with
// `user:pass@` handed to the OS, and a terminal spawned at 0, NaN, negative or
// 100 000 columns (resize already refused those).

const spawned = vi.hoisted(() => [] as Array<{ cols: number; rows: number }>)
vi.mock('node-pty', () => ({ spawn: vi.fn((_shell: string, _args: string[], opts: { cols: number; rows: number }) => {
  spawned.push({ cols: opts.cols, rows: opts.rows })
  return { pid: 4242, write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: () => {}, onExit: () => {} }
}) }))
vi.mock('electron', () => ({ BrowserWindow: class {} }))
vi.mock('../src/core/cast-index', () => ({ indexCast: vi.fn(async () => undefined) }))

import { initDB, closeDB } from '../src/core/db/index'
import { _resetIngest } from '../src/core/ingest'
import { ensurePrimaryOperator, generateToken } from '../src/core/db/operators'
import { registerMarkersIpc } from '../src/main/ipc/markers'
import { externalUrlAllowed } from '../src/core/external-url'
import { configureTerminal, spawnTerminal, killAllTerminals, spawnTerminalSize } from '../src/main/terminal-manager'
import type { IpcContext } from '../src/main/ipc/types'

type Handler = (_e: unknown, ...args: unknown[]) => unknown

let dir: string
let homeSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-bounds-'))
  homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(dir)
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'engagement:\n  id: eng-1\noperator:\n  id: op-1\n')
  initDB(dir)
  _resetIngest()
})
afterEach(() => {
  killAllTerminals()
  closeDB()
  homeSpy.mockRestore()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('marker:create text limits', () => {
  it('cuts title and notes to the HUD form limits (200 / 10 000)', () => {
    const handlers = new Map<string, Handler>()
    const ctx = { getActiveProject: () => ({ id: 'eng-1', name: 'T', path: dir, createdAt: 1, lastOpened: 1 }) } as unknown as IpcContext
    registerMarkersIpc({ handle: (n: string, fn: Handler) => handlers.set(n, fn) } as never, ctx, {} as never)
    const marker = handlers.get('marker:create')!({}, { title: 't'.repeat(1 << 20), notes: 'n'.repeat(1 << 20) }) as { data: Record<string, unknown> }
    expect(String(marker.data.title).length).toBe(200)
    expect(String(marker.data.notes).length).toBe(10_000)
    const plain = handlers.get('marker:create')!({}, { title: 'short', notes: 'kept' }) as { data: Record<string, unknown> }
    expect(plain.data).toMatchObject({ title: 'short', notes: 'kept' })
  })
})

describe('app:openExternal URL check', () => {
  it.each(['https://example.com/docs', 'http://127.0.0.1:8080/x?y=1'])('allows %s', (u) => {
    expect(externalUrlAllowed(u)).toBe(true)
  })
  it.each([
    'http://user:pass@host/x', 'https://user@host/', 'https://:secret@host/',
    'file:///etc/passwd', 'javascript:alert(1)', 'smb://host/share', 'not a url', 42
  ])('refuses %j', (u) => {
    expect(externalUrlAllowed(u)).toBe(false)
  })
})

describe('terminal spawn size', () => {
  it.each([[0, 24], [80, 0], [-5, 24], [NaN, NaN], [100_000, 24], [80, 100_000], [80.5, 24], ['80', '24']])(
    'spawns %j x %j at 80x24', (cols, rows) => {
      expect(spawnTerminalSize(cols, rows)).toEqual({ cols: 80, rows: 24 })
    })
  it('keeps a real size', () => {
    expect(spawnTerminalSize(132, 43)).toEqual({ cols: 132, rows: 43 })
  })
  it('node-pty never receives an invalid size', () => {
    ensurePrimaryOperator('op-1', 'Operator', generateToken())
    configureTerminal({ identity: { projectId: 'eng-1', engagementId: 'eng-1', operatorId: 'op-1' } })
    spawned.length = 0
    spawnTerminal('pane-zero', 0, 0)
    spawnTerminal('pane-huge', 100_000, 100_000)
    spawnTerminal('pane-nan', NaN, -1)
    spawnTerminal('pane-ok', 120, 40)
    expect(spawned).toEqual([{ cols: 80, rows: 24 }, { cols: 80, rows: 24 }, { cols: 80, rows: 24 }, { cols: 120, rows: 40 }])
  })
})
