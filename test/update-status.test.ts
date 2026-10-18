import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { UpdateStatusStore, hasInstallerFor } from '../src/main/services/update-status'
import { UpdateFlow, type UpdateFlowDeps, type UpdateFlowState } from '../src/main/services/update-flow'

// Spec 061 FR-001 / FR-002: About can say what the last check found and what is
// happening now, and a check that failed or found nothing installable is never
// worded as "up to date".

describe('UpdateStatusStore', () => {
  const make = () => new UpdateStatusStore({ method: 'download-page', packaged: true, currentVersion: '1.0.0', releaseUrl: 'https://x/releases' })

  it('starts idle with nothing claimed about any check', () => {
    expect(make().get()).toMatchObject({ stage: 'idle', result: null, checkedAt: null, targetVersion: null, progress: null })
  })

  it('tells listeners about every change and stops after unsubscribe', () => {
    const store = make()
    const seen: string[] = []
    const off = store.onChange((s) => seen.push(s.stage))
    store.patch({ stage: 'checking' })
    store.patch({ stage: 'failed', result: 'failed' })
    off()
    store.patch({ stage: 'idle' })
    expect(seen).toEqual(['checking', 'failed'])
  })

  it('hands out copies, so a reader cannot change the state', () => {
    const store = make()
    store.get().stage = 'ready'
    expect(store.get().stage).toBe('idle')
  })
})

describe('hasInstallerFor', () => {
  const release = ['latest-mac.yml', 'RedLog-0.18.3-arm64-mac.zip', 'RedLog-0.18.3-arm64.dmg', 'RedLog-0.18.3-arm64.dmg.blockmap',
    'RedLog.Setup.0.18.3.exe', 'RedLog.Setup.0.18.3.exe.blockmap', 'redlog_0.18.3_amd64.deb', 'SHA256SUMS.txt']

  it('finds the installer of each platform the project ships', () => {
    expect(hasInstallerFor(release, 'darwin', 'arm64')).toBe(true)
    expect(hasInstallerFor(release, 'win32', 'x64')).toBe(true)
    expect(hasInstallerFor(release, 'linux', 'x64')).toBe(true)
  })

  it('does not count another architecture, a blockmap, or a platform with no file', () => {
    expect(hasInstallerFor(release, 'darwin', 'x64')).toBe(false)
    expect(hasInstallerFor(['RedLog.Setup.1.exe.blockmap'], 'win32', 'x64')).toBe(false)
    expect(hasInstallerFor(['RedLog-1-arm64.dmg'], 'win32', 'x64')).toBe(false)
    expect(hasInstallerFor([], 'darwin', 'arm64')).toBe(false)
    expect(hasInstallerFor(release, 'freebsd', 'x64')).toBe(false)
  })
})

describe('UpdateFlow reports its state and can be cancelled', () => {
  function setup(port: Partial<UpdateFlowDeps['port']>, over: Partial<UpdateFlowDeps> = {}) {
    const states: Array<[UpdateFlowState, string | null]> = []
    const deps: UpdateFlowDeps = {
      port: { download: async () => {}, quitAndInstall: vi.fn(), ...port },
      askDownload: async () => true,
      announceReady: async () => 'later',
      impact: () => null,
      confirmRestart: async () => true,
      onDownloadFailed: vi.fn(async () => {}),
      beforeRestart: async () => {},
      allowQuit: () => {},
      onState: (state, ready) => { states.push([state, ready]) },
      ...over
    }
    return { flow: new UpdateFlow(deps), deps, states }
  }

  it('moves downloading → ready and carries the version with ready', async () => {
    const { flow, states } = setup({})
    await flow.offer('2.0.0')
    expect(states).toEqual([['downloading', null], ['ready', '2.0.0']])
  })

  it('a cancelled download goes back to idle without being reported as a failure', async () => {
    let reject!: (e: Error) => void
    const { flow, deps, states } = setup({
      download: () => new Promise<void>((_r, rej) => { reject = rej }),
      cancelDownload: () => reject(new Error('cancelled'))
    })
    const running = flow.offer('2.0.0')
    await vi.waitFor(() => expect(flow.status().state).toBe('downloading'))
    expect(flow.cancel()).toBe(true)
    await running
    expect(flow.status().state).toBe('idle')
    expect(deps.onDownloadFailed).not.toHaveBeenCalled()
    expect(states.map(([s]) => s)).toEqual(['downloading', 'idle'])
  })

  it('a failure after an earlier cancel is still reported', async () => {
    let reject!: (e: Error) => void
    let attempt = 0
    const { flow, deps } = setup({
      download: () => new Promise<void>((_r, rej) => { attempt++; reject = rej }),
      cancelDownload: () => reject(new Error('cancelled'))
    })
    const first = flow.offer('2.0.0')
    await vi.waitFor(() => expect(flow.status().state).toBe('downloading'))
    flow.cancel()
    await first
    const second = flow.offer('2.0.0')
    await vi.waitFor(() => expect(attempt).toBe(2))
    reject(new Error('network down'))
    await second
    expect(deps.onDownloadFailed).toHaveBeenCalledTimes(1)
  })

  it('cannot cancel when nothing is downloading, or when the port cannot stop one', async () => {
    const idle = setup({ cancelDownload: vi.fn() })
    expect(idle.flow.cancel()).toBe(false)
    expect(idle.deps.port.cancelDownload).not.toHaveBeenCalled()

    let release!: () => void
    const noStop = setup({ download: () => new Promise<void>((r) => { release = r }) })
    const running = noStop.flow.offer('2.0.0')
    await vi.waitFor(() => expect(noStop.flow.status().state).toBe('downloading'))
    expect(noStop.flow.cancel()).toBe(false)
    release()
    await running
    expect(noStop.flow.status().state).toBe('ready')
  })
})

// The wiring, not the logic: no check may end in a dialog saying "latest" when
// it did not find out, and a second press must not start a second check.
describe('updater.ts wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/services/updater.ts'), 'utf8')

  it('records how a check ended instead of asking a dialog to', () => {
    expect(src).not.toContain('已是最新版')
    expect(src).not.toContain('Update check is disabled in air-gap mode')
    expect(src).toMatch(/result: 'airgap'/)
    expect(src).toMatch(/result: 'noInstaller'/)
    expect(src).toMatch(/result: 'upToDate'/)
  })

  it('checks once at a time', () => {
    expect(src).toMatch(/if \(inFlight\) return inFlight/)
  })

  it('makes no request in air-gap mode before looking at the flag', () => {
    const run = src.slice(src.indexOf('async function runCheck'))
    expect(run.indexOf('if (airgap)')).toBeGreaterThan(-1)
    // Both ways of asking the network are reached only through runCheck.
    expect(run.indexOf('await windowsAutoUpdate()')).toBeGreaterThan(-1)
    expect(run.indexOf('await browserFallbackUpdate()')).toBeGreaterThan(-1)
    expect(run.indexOf('if (airgap)')).toBeLessThan(run.indexOf('await windowsAutoUpdate()'))
    expect(run.indexOf('if (airgap)')).toBeLessThan(run.indexOf('await browserFallbackUpdate()'))
    expect(src.match(/windowsAutoUpdate\(\)/g)?.length).toBe(2) // declaration + the one call
    expect(src.match(/browserFallbackUpdate\(\)/g)?.length).toBe(2)
  })
})
