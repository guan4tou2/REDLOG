import { describe, it, expect, vi } from 'vitest'
import { UpdateFlow, type UpdateFlowDeps } from '../src/main/services/update-flow'
import type { QuitImpact } from '../src/main/quit-guard'

// Spec 061 FR-004 / FR-005: downloading is one decision, restarting another,
// and the restart asks about what is live when it asks.

const live = (over: Partial<QuitImpact> = {}): QuitImpact =>
  ({ terminals: 1, proxyRunning: true, externalActive: false, project: 'acme', ...over })

function setup(over: Partial<UpdateFlowDeps> = {}) {
  const calls: string[] = []
  const deps: UpdateFlowDeps = {
    port: {
      download: vi.fn(async () => { calls.push('download') }),
      quitAndInstall: vi.fn(() => { calls.push('quitAndInstall') })
    },
    askDownload: vi.fn(async () => true),
    announceReady: vi.fn(async () => 'later' as const),
    impact: vi.fn(() => null),
    confirmRestart: vi.fn(async () => true),
    onDownloadFailed: vi.fn(async () => {}),
    beforeRestart: vi.fn(async () => { calls.push('beforeRestart') }),
    allowQuit: vi.fn(() => { calls.push('allowQuit') }),
    ...over
  }
  return { flow: new UpdateFlow(deps), deps, calls }
}

describe('a finished download', () => {
  it('only says ready: it neither quits nor installs', async () => {
    const { flow, deps } = setup()
    await flow.offer('2.0.0')
    expect(deps.port.download).toHaveBeenCalledTimes(1)
    expect(deps.announceReady).toHaveBeenCalledWith('2.0.0')
    expect(deps.port.quitAndInstall).not.toHaveBeenCalled()
    expect(deps.allowQuit).not.toHaveBeenCalled()
    expect(flow.status()).toEqual({ state: 'ready', readyVersion: '2.0.0' })
  })

  it('downloads nothing when the operator declines', async () => {
    const { flow, deps } = setup({ askDownload: vi.fn(async () => false) })
    await flow.offer('2.0.0')
    expect(deps.port.download).not.toHaveBeenCalled()
    expect(flow.status().state).toBe('idle')
  })

  it('leaves the current version running when the download fails', async () => {
    const { flow, deps } = setup({ port: { download: async () => { throw new Error('net') }, quitAndInstall: vi.fn() } })
    await flow.offer('2.0.0')
    expect(deps.onDownloadFailed).toHaveBeenCalled()
    expect(flow.status().state).toBe('idle')
  })

  it('does not start a second download while one is running', async () => {
    let release!: () => void
    const { flow, deps } = setup({ port: { download: () => new Promise<void>((r) => { release = r }), quitAndInstall: vi.fn() } })
    const first = flow.offer('2.0.0')
    await vi.waitFor(() => expect(flow.status().state).toBe('downloading'))
    await flow.offer('2.0.0')
    expect(deps.askDownload).toHaveBeenCalledTimes(1)
    release(); await first
  })
})

describe('restarting', () => {
  it('happens only when the operator picks it, after saving, with the quit allowed', async () => {
    const { flow, calls } = setup({ announceReady: vi.fn(async () => 'now' as const) })
    await flow.offer('2.0.0')
    expect(calls).toEqual(['download', 'beforeRestart', 'allowQuit', 'quitAndInstall'])
  })

  it('asks what is live, and a no leaves everything as it was', async () => {
    const { flow, deps } = setup({
      impact: vi.fn(() => live()),
      confirmRestart: vi.fn(async () => false)
    })
    await flow.offer('2.0.0')
    await flow.install()
    expect(deps.confirmRestart).toHaveBeenCalledWith(live(), '2.0.0')
    expect(deps.beforeRestart).not.toHaveBeenCalled()
    expect(deps.port.quitAndInstall).not.toHaveBeenCalled()
    expect(flow.status().state).toBe('ready')
  })

  it('asks nothing when nothing is live', async () => {
    const { flow, deps } = setup()
    await flow.offer('2.0.0')
    await flow.install()
    expect(deps.confirmRestart).not.toHaveBeenCalled()
    expect(deps.port.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('asks again when what is live changed while the question was open', async () => {
    const states = [live({ terminals: 1 }), live({ terminals: 3 }), live({ terminals: 3 }), live({ terminals: 3 })]
    let i = 0
    const { flow, deps } = setup({
      impact: vi.fn(() => states[Math.min(i++, states.length - 1)]),
      confirmRestart: vi.fn(async () => true)
    })
    await flow.offer('2.0.0')
    await flow.install()
    expect(deps.confirmRestart).toHaveBeenCalledTimes(2)
    expect(vi.mocked(deps.confirmRestart).mock.calls[1][0].terminals).toBe(3)
    expect(deps.port.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('stays ready, and does not quit, when saving fails', async () => {
    const { flow, deps } = setup({ beforeRestart: vi.fn(async () => { throw new Error('disk') }) })
    await flow.offer('2.0.0')
    await expect(flow.install()).rejects.toThrow('disk')
    expect(deps.port.quitAndInstall).not.toHaveBeenCalled()
    expect(flow.status().state).toBe('ready')
  })

  it('a later offer for an already downloaded update goes straight to the restart question', async () => {
    const { flow, deps } = setup({ impact: vi.fn(() => live()), confirmRestart: vi.fn(async () => false) })
    await flow.offer('2.0.0')
    await flow.offer('2.0.0')
    expect(deps.port.download).toHaveBeenCalledTimes(1)
    expect(deps.askDownload).toHaveBeenCalledTimes(1)
    expect(deps.confirmRestart).toHaveBeenCalledTimes(1)
  })
})

// The wiring, not the flow: nothing in the updater may restart on its own or
// bring back the window that could not be closed (FR-004, FR-011).
describe('updater.ts wiring', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/main/services/updater.ts'), 'utf8') as string

  it('has no progress window and no download-then-quit path', () => {
    expect(src).not.toMatch(/new BrowserWindow/)
    expect(src).not.toMatch(/alwaysOnTop/)
    // The only quitAndInstall is the port handed to UpdateFlow.
    expect((src.match(/\.quitAndInstall\(/g) ?? []).length).toBe(1)
    expect(src).toMatch(/quitAndInstall: \(\) => autoUpdater\.quitAndInstall/)
  })

  it('no longer promises an automatic restart', () => {
    expect(src).not.toContain('下載完成後將自動安裝並重新啟動')
  })
})
