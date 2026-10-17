import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// A pane's environment is fixed when it opens. After the managed proxy stops,
// every pane opened while routing was on still names a dead port, so the stop
// has to be able to say how many.

const fake = vi.hoisted(() => ({ envs: [] as Array<Record<string, string>>, n: 0 }))
vi.mock('node-pty', () => ({ spawn: vi.fn((_s: string, _a: string[], o: { env: Record<string, string> }) => {
  fake.envs.push(o.env)
  return { pid: 2000 + fake.n++, write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: vi.fn(), onExit: vi.fn() }
}) }))
vi.mock('electron', () => ({ BrowserWindow: class {} }))
vi.mock('../src/core/cast-index', () => ({ indexCast: vi.fn(async () => undefined) }))
import { initDB, closeDB } from '../src/core/db/index'
import { configureIngest, _resetIngest } from '../src/core/ingest'
import { ensurePrimaryOperator, generateToken } from '../src/core/db/operators'
import { eventBus } from '../src/core/event-bus'
import { configureTerminal, configureTerminalProxy, countProxiedTerminals, spawnTerminal, killAllTerminals, getCastPosition } from '../src/main/terminal-manager'

let root: string
let homeSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-stale-proxy-'))
  homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(root)
  fake.envs.length = 0
  eventBus.resume('ui')
  _resetIngest()
  initDB(path.join(root, 'P'))
  ensurePrimaryOperator('operator', 'Operator', generateToken())
  configureTerminal({ engagementId: 'P', projectId: 'P', operatorId: 'operator' })
  configureIngest({ castProbe: getCastPosition })
})
afterEach(() => {
  killAllTerminals(); closeDB(); _resetIngest(); configureTerminalProxy(() => null)
  homeSpy.mockRestore(); fs.rmSync(root, { recursive: true, force: true })
})

describe('panes that outlive the managed proxy', () => {
  it('counts only the panes opened while the proxy was routed', () => {
    let url: string | null = 'http://127.0.0.1:6661'
    configureTerminalProxy(() => url)
    spawnTerminal('with-proxy', 80, 24)
    url = null // the proxy stopped
    spawnTerminal('after-stop', 80, 24)
    expect(fake.envs[0].HTTP_PROXY).toBe('http://127.0.0.1:6661')
    expect(fake.envs[1].HTTP_PROXY).toBeUndefined()
    expect(countProxiedTerminals()).toBe(1)
  })

  it('counts none when routing was never on', () => {
    configureTerminalProxy(() => null)
    spawnTerminal('plain', 80, 24)
    expect(countProxiedTerminals()).toBe(0)
  })
})
