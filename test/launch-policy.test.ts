import { describe, it, expect } from 'vitest'
import { launchPolicy } from '../src/main/launch-policy'

const argv = ['/Applications/RedLog.app/Contents/MacOS/RedLog', '--js-flags=--allow-natives-syntax', '--remote-debugging-pipe', '--remote-debugging-port=0', '--inspect=0']
const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-address', 'remote-allow-origins']
const RELEASE = false
const SMOKE = true

describe('launchPolicy', () => {
  it('changes nothing in dev or an unpackaged e2e launch, whatever the variant', () => {
    for (const smoke of [RELEASE, SMOKE]) {
      expect(launchPolicy(argv, { REDLOG_KEYS_DIR: '/tmp/k', REDLOG_E2E: '1' }, false, smoke)).toEqual({ removeSwitches: [], clearEnv: [], dropped: [] })
    }
  })

  it('removes --js-flags and --remote-debugging-pipe from a packaged launch, present or not', () => {
    for (const smoke of [RELEASE, SMOKE]) {
      expect(launchPolicy(argv, {}, true, smoke).removeSwitches.slice(0, 2)).toEqual(['js-flags', 'remote-debugging-pipe'])
      expect(launchPolicy(['/x/RedLog'], {}, true, smoke).removeSwitches.slice(0, 2)).toEqual(['js-flags', 'remote-debugging-pipe'])
    }
  })

  it('removes every remote-debugging-port switch from a packaged release launch, present or not', () => {
    expect(launchPolicy(['/x/RedLog'], {}, true, RELEASE).removeSwitches).toEqual(['js-flags', 'remote-debugging-pipe', ...DEBUG_SWITCHES])
  })

  it.each([
    ['--remote-debugging-port', '--remote-debugging-port'],
    ['--remote-debugging-port=9222', '--remote-debugging-port'],
    ['-remote-debugging-port=9222', '--remote-debugging-port'],
    ['--remote-debugging-address=0.0.0.0', '--remote-debugging-address'],
    ['--remote-allow-origins=*', '--remote-allow-origins']
  ])('reports %s as dropped from a packaged release launch', (arg, reported) => {
    expect(launchPolicy(['/x/RedLog', arg], {}, true, RELEASE).dropped).toEqual([reported])
  })

  it('makes the signing-key test seam inert in a packaged launch', () => {
    expect(launchPolicy([], { REDLOG_KEYS_DIR: '/tmp/k' }, true, RELEASE).clearEnv).toEqual(['REDLOG_KEYS_DIR'])
    expect(launchPolicy([], {}, true, RELEASE).clearEnv).toEqual([])
  })

  it('reports only what the launch carried', () => {
    expect(launchPolicy(argv, { REDLOG_KEYS_DIR: '/tmp/k' }, true, SMOKE).dropped).toEqual(['--js-flags', '--remote-debugging-pipe', 'REDLOG_KEYS_DIR'])
    expect(launchPolicy(argv, { REDLOG_KEYS_DIR: '/tmp/k' }, true, RELEASE).dropped).toEqual(['--js-flags', '--remote-debugging-pipe', '--remote-debugging-port', 'REDLOG_KEYS_DIR'])
    expect(launchPolicy(['/x/RedLog', '--js-flagsX', '--remote-debugging-portX=1'], {}, true, RELEASE).dropped).toEqual([])
  })

  // e2e/packaged-*.spec.ts drive the installed SMOKE build through Playwright's
  // electron.launch, which passes these itself and sets REDLOG_E2E.
  it('leaves what the packaged smoke harness needs in a smoke build', () => {
    const policy = launchPolicy(argv, { REDLOG_E2E: '1', REDLOG_E2E_HIDE_HUD: '1' }, true, SMOKE)
    for (const name of DEBUG_SWITCHES) expect(policy.removeSwitches).not.toContain(name)
    expect(policy.removeSwitches).not.toContain('inspect')
    expect(policy.clearEnv).toEqual([])
  })
})
