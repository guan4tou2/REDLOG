import { describe, it, expect } from 'vitest'
import { launchPolicy } from '../src/main/launch-policy'

const argv = ['/Applications/RedLog.app/Contents/MacOS/RedLog', '--js-flags=--allow-natives-syntax', '--remote-debugging-pipe', '--remote-debugging-port=0', '--inspect=0']

describe('launchPolicy', () => {
  it('changes nothing in dev or an unpackaged e2e launch', () => {
    expect(launchPolicy(argv, { REDLOG_KEYS_DIR: '/tmp/k', REDLOG_E2E: '1' }, false)).toEqual({ removeSwitches: [], clearEnv: [], dropped: [] })
  })

  it('removes --js-flags and --remote-debugging-pipe from a packaged launch, present or not', () => {
    expect(launchPolicy(argv, {}, true).removeSwitches).toEqual(['js-flags', 'remote-debugging-pipe'])
    expect(launchPolicy(['/x/RedLog'], {}, true).removeSwitches).toEqual(['js-flags', 'remote-debugging-pipe'])
  })

  it('makes the signing-key test seam inert in a packaged launch', () => {
    expect(launchPolicy([], { REDLOG_KEYS_DIR: '/tmp/k' }, true).clearEnv).toEqual(['REDLOG_KEYS_DIR'])
    expect(launchPolicy([], {}, true).clearEnv).toEqual([])
  })

  it('reports only what the launch carried', () => {
    expect(launchPolicy(argv, { REDLOG_KEYS_DIR: '/tmp/k' }, true).dropped).toEqual(['--js-flags', '--remote-debugging-pipe', 'REDLOG_KEYS_DIR'])
    expect(launchPolicy(['/x/RedLog', '--js-flagsX'], {}, true).dropped).toEqual([])
  })

  // e2e/packaged-*.spec.ts drive the packaged app through Playwright's
  // electron.launch, which passes these itself and sets REDLOG_E2E.
  it('leaves what the packaged smoke harness needs', () => {
    const policy = launchPolicy(argv, { REDLOG_E2E: '1', REDLOG_E2E_HIDE_HUD: '1' }, true)
    expect(policy.removeSwitches).not.toContain('remote-debugging-port')
    expect(policy.removeSwitches).not.toContain('inspect')
    expect(policy.clearEnv).toEqual([])
  })
})
