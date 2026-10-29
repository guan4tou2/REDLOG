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

describe('UpdateFlow when the save before a restart fails', () => {
  const ready = async (over: Partial<UpdateFlowDeps>) => {
    const quit = vi.fn()
    const deps: UpdateFlowDeps = {
      port: { download: async () => {}, quitAndInstall: quit },
      askDownload: async () => true, announceReady: async () => 'later', impact: () => null,
      confirmRestart: async () => true, onDownloadFailed: async () => {},
      beforeRestart: async () => {}, allowQuit: vi.fn(), ...over
    }
    const flow = new UpdateFlow(deps)
    await flow.offer('2.0.0')
    return { flow, deps, quit }
  }

  it('does not restart, and stays ready, when the operator cancels', async () => {
    const { flow, deps, quit } = await ready({
      beforeRestart: async () => { throw new Error('marker: disk full') },
      onRestartBlocked: vi.fn(async () => 'cancel' as const)
    })
    await flow.install()
    expect(deps.onRestartBlocked).toHaveBeenCalledTimes(1)
    expect(quit).not.toHaveBeenCalled()
    expect(deps.allowQuit).not.toHaveBeenCalled()
    expect(flow.status().state).toBe('ready')
  })

  it('tries the save again on retry and restarts only once it succeeded', async () => {
    let attempts = 0
    const { flow, quit } = await ready({
      beforeRestart: async () => { if (++attempts < 3) throw new Error('busy') },
      onRestartBlocked: async () => 'retry'
    })
    await flow.install()
    expect(attempts).toBe(3)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('without a handler the error reaches the caller and nothing restarts', async () => {
    const { flow, quit } = await ready({ beforeRestart: async () => { throw new Error('boom') } })
    await expect(flow.install()).rejects.toThrow('boom')
    expect(quit).not.toHaveBeenCalled()
    expect(flow.status().state).toBe('ready')
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

  it('stops the restart when this machine could not write its own record', () => {
    expect(src).toMatch(/if \(result\.localError\) throw new Error\(result\.localError\)/)
    expect(src).toMatch(/onRestartBlocked/)
    // Air-gap is passed to both places that anchor, so neither asks the network.
    expect((src.match(/offline: airgap/g) ?? []).length).toBe(1)
  })
})

// T022: the restart reaches the recording through the ordinary quit. If it did
// not, finishing recordings would need a path of its own.
describe('the quit that an update ends with', () => {
  const index = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8')

  it('finishes terminal recordings while the database is still open', () => {
    const stop = index.slice(index.indexOf('function stopProject'))
    expect(stop.indexOf('clean(detachTerminalRecordings)')).toBeGreaterThan(-1)
    expect(stop.indexOf('clean(detachTerminalRecordings)')).toBeLessThan(stop.indexOf('clean(closeDB)'))
    const willQuit = index.slice(index.indexOf("app.on('will-quit'"))
    expect(willQuit.slice(0, 400)).toContain('stopProject()')
  })

  it('judges the update when the project opens, and clears the marker only after the record was written', () => {
    const at = index.indexOf('readUpdateMarker(')
    expect(at).toBeGreaterThan(-1)
    const block = index.slice(at, at + 900)
    expect(block.indexOf('recordUpdateOutcome(')).toBeLessThan(block.indexOf('clearUpdateMarker('))
  })

  // Spec 061 US4: on the manual path RedLog restarts nothing, so there is no
  // pause to mark and no network call to make; the running version decides.
  it('opening the download page marks nothing in the chain and asks no network, it only remembers the target', () => {
    const updater = fs.readFileSync(path.join(__dirname, '../src/main/services/updater.ts'), 'utf8')
    const fallback = updater.slice(updater.indexOf('async function browserFallbackUpdate'), updater.indexOf('// Public API'))
    expect(fallback).not.toContain('anchorBeforeRestart')
    expect(fallback).toMatch(/method: 'manual'/)
  })

  it('does not let a page that was only opened count as an update', () => {
    const index = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8')
    const at = index.indexOf("marker.method === 'manual'")
    expect(at).toBeGreaterThan(-1)
    // The manual-and-not-applied branch comes first and writes nothing.
    const branch = index.slice(at, index.indexOf('} else if', at))
    expect(branch).not.toContain('recordUpdateOutcome')
    expect(branch).not.toContain('clearUpdateMarker')
  })

  it('looks by itself at launch only when the operator has not switched it off', () => {
    const index = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8')
    expect(index).toMatch(/if \(autoCheckEnabled\(\)\) checkForUpdates\(\)/)
    // The switch is not consulted for a press of the button.
    expect(index).toMatch(/ipcMain\.handle\('app:checkForUpdates', \(\) => checkForUpdates\(\{ manual: true \}\)\)/)
  })
})
