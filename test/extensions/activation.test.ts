// Spec 076 T008 (US2, FR-032; 13 號 C.1 #19 and #23): an optional source that
// nobody has asked for has no process and no timer.
//
// US2's independent test: new install, new project, and nothing is running that
// the operator did not start — no mitmdump child, no CDP poll timer. Two sources
// are named; what main does with each today is not the same, and this file says
// which is which rather than marking both as broken.
//
//   #23 managed mitmdump   BROKEN. Opening a project starts mitmdump whenever it
//        is on PATH and the proxy is stopped (index.ts, once per open), with no
//        operator action. A fresh state and a machine that has mitmdump is the
//        whole condition. The correct answer under FR-032 is "no start event
//        holds, so do not start": `it.fails` below. Phase 3 makes the proxy
//        start on `project-open` only when machine-enabled (default off).
//
//   #19 CDP poll timer     NOT BROKEN AT PROJECT OPEN, today. The timer is
//        registered by `configureCdpMonitor({ enabled: true })`, and index.ts
//        calls that in exactly one place, launching the capture browser. A new
//        project registers none; `onBrowserExit` and `browser:stop` clear it.
//        The 13 号 report's "keeps polling after the browser exits" was fixed
//        after it was written. These are passing pins, so that moving the
//        registration (Phase 8 takes the browser to the host) cannot add a
//        timer at project open unnoticed. They are source-text pins for
//        index.ts, which a test cannot import, and behavioural for the
//        connector, which it can.
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { shouldAutoStartHttpCapture } from '../../src/core/http-autostart'
import { managedHttpProxy } from '../../src/main/services/managed-http-proxy'
import { startCdpMonitor, stopCdpMonitor, configureCdpMonitor } from '../../src/main/services/cdp-connector'

const MAIN_INDEX = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'index.ts'), 'utf8')
const code = MAIN_INDEX.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

describe('#23 managed mitmdump: what a new project does today', () => {
  it('a fresh proxy is stopped, so a new project is exactly the state the auto-start acts on', () => {
    expect(managedHttpProxy.status().state).toBe('stopped')
  })

  it('today: mitmdump on PATH and a stopped proxy is enough to start it, with no operator action', () => {
    expect(shouldAutoStartHttpCapture({ mitmdumpOnPath: true, state: managedHttpProxy.status().state })).toBe(true)
  })

  it('today: the only caller of that decision is the project-open path, once', () => {
    expect(code.match(/shouldAutoStartHttpCapture\(/g)).toHaveLength(1)
    // ...and it starts the proxy right there.
    expect(code).toMatch(/shouldAutoStartHttpCapture\(\{[\s\S]{0,200}?\}\)\) return\s+return startManagedHttpCapture\(\)/)
  })

  // Correct behaviour (FR-032): no start event holds on a new machine, so no mitmdump.
  it.fails('a new project on a machine with mitmdump starts no mitmdump', () => {
    expect(shouldAutoStartHttpCapture({ mitmdumpOnPath: true, state: managedHttpProxy.status().state })).toBe(false)
  })
})

describe('#19 CDP poll timer: what registers it today', () => {
  afterEach(() => { stopCdpMonitor(); vi.useRealTimers() })

  it('configuring the monitor without enabling it registers no timer', () => {
    vi.useFakeTimers()
    configureCdpMonitor({ identity: { projectId: 'p', engagementId: 'e', operatorId: 'o' } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('starting it registers one 3 s timer, and stopping removes it', () => {
    vi.useFakeTimers()
    startCdpMonitor()
    startCdpMonitor()
    expect(vi.getTimerCount()).toBe(1)
    stopCdpMonitor()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('index.ts enables it in exactly one place: launching the capture browser, never at project open', () => {
    const enables = [...code.matchAll(/configureCdpMonitor\(\{[^}]*enabled:\s*true[^}]*\}\)/g)]
    expect(enables).toHaveLength(1)
    // That call sits inside launchCaptureBrowser, after the browser launched.
    const launch = code.slice(code.indexOf('async function launchCaptureBrowser'))
    expect(launch.indexOf(enables[0][0])).toBeGreaterThan(-1)
    expect(launch.indexOf('const result = launchBrowser(')).toBeLessThan(launch.indexOf(enables[0][0]))
    expect(code.match(/\bstartCdpMonitor\(/g) ?? []).toHaveLength(0)
  })

  it('index.ts clears it when the browser exits and when it is stopped by hand', () => {
    expect(code).toMatch(/onBrowserExit\(\(\) => \{\s*stopCdpMonitor\(\)/)
    expect(code).toMatch(/ipcMain\.handle\('browser:stop', \(\) => \{ stopCdpMonitor\(\)/)
  })
})
