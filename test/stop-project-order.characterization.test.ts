// Spec 073 T004. The order in which src/main/index.ts closes a project
// (`stopProject`) and opens one (`startProject` -> `startProjectResources`,
// with the OPEN_SEQUENCE hooks), recorded as it runs today, with doubles for
// everything the functions touch (test/helpers/project-lifecycle-trace.ts
// says how, and why this runs main's real code rather than a copy of it).
//
// This is a characterization: it records, it does not approve. Phase 3 of
// Spec 073 replaces both functions with a resource list started in order and
// stopped in reverse; its order snapshot is compared against this file, and
// each difference has to be one the plan names (plan.md "與今天 stopProject
// 順序的刻意差異": the HUD/tray come down first, anchor and ntp swap,
// project_closed is new).
//
// Golden: test/fixtures/stop-project-order.golden.json. To rewrite it after an
// intended change: REDLOG_WRITE_LIFECYCLE_ORDER=1 npx vitest run <this file>.
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { countCleanSteps, makeHarness } from './helpers/project-lifecycle-trace'

const GOLDEN = path.join(__dirname, 'fixtures', 'stop-project-order.golden.json')
const WRITE = process.env.REDLOG_WRITE_LIFECYCLE_ORDER === '1'

interface Recorded {
  stopProject: string[]
  stopProjectWithRecomputePending: string[]
  openFresh: { linux: string[]; darwin: string[] }
  openOverAnOpenProject: string[]
}

const HUD_UP = { overlayWindow: '@double', tray: '@double', recomputeTimer: null, recomputePending: null }

function stop(initial: Record<string, unknown> = {}): string[] {
  const h = makeHarness({ platform: 'linux', initial: { ...HUD_UP, ...initial } })
  h.stopProject()
  return h.trace.calls
}

function open(platform: string, over?: boolean): string[] {
  const h = makeHarness({
    platform,
    initial: { overlayWindow: null, tray: '@double', recomputeTimer: null, recomputePending: null },
    overrides: over ? { 'projectRuntime.current': () => ({}) } : {}
  })
  h.startProject({ id: 'p' })
  return h.trace.calls
}

function record(): Recorded {
  return {
    stopProject: stop(),
    stopProjectWithRecomputePending: stop({ recomputeTimer: '@double' }),
    openFresh: { linux: open('linux'), darwin: open('darwin') },
    openOverAnOpenProject: open('linux', true)
  }
}

describe('project close and open order, as it is today (Spec 073 T004)', () => {
  it('stopProject has 27 clean() steps, as the plan counts them', () => {
    expect(countCleanSteps()).toBe(27)
  })

  it('records the same twice (no path, time, platform or locale in the record)', () => {
    expect(record()).toEqual(record())
  })

  it('stopProject runs the runtime close first and the tray last', () => {
    const calls = stop()
    expect(calls[0]).toBe('projectRuntime.close()')
    expect(calls.at(-1)).toBe('setTrayRecording(<tray>, null)')
    // The DB closes after every binding that needs it and before the resets that follow it.
    const at = (s: string): number => calls.indexOf(s)
    expect(at('detachTerminalRecordings()')).toBeLessThan(at('closeDB()'))
    expect(at('closeDB()')).toBeLessThan(at('resetBodiesDirCache()'))
  })

  it('startProject opens the DB before it starts resources, and starts the API binding after the config sequence', () => {
    const calls = open('linux')
    const at = (s: string): number => calls.findIndex((c) => c.startsWith(s))
    expect(at('initDB(')).toBeLessThan(at('bindDBEngagement('))
    expect(at('bindDBEngagement(')).toBeLessThan(at('  apply.step wifiName'))
    expect(at('  apply.step agentTailer')).toBeLessThan(at('configureApi('))
    expect(at('configureApi(')).toBeLessThan(at('onApiProjectOpen('))
    expect(at('writeSpoolIdentity(')).toBeGreaterThan(at('onApiProjectOpen('))
    expect(calls.at(-1)).toBe('projectRuntime.activate(<projectRuntime.begin()>)')
  })

  it('the open sequence hooks run at the places OPEN_SEQUENCE gives them', () => {
    const hooks = open('linux').filter((c) => c.startsWith('  apply.hook') && !c.startsWith('  } '))
    expect(hooks).toEqual([
      '  apply.hook resetProjectCaches {',
      '  apply.hook loadPlugins {',
      '  apply.hook wireTerminalIngest {',
      '  apply.hook startProjectServices {'
    ])
  })

  it('opening over an open project reads the new config first, closes the old project, then opens the new one', () => {
    const calls = open('linux', true)
    const at = (s: string): number => calls.findIndex((c) => c.startsWith(s))
    expect(at('prepareOpenConfig(')).toBeGreaterThanOrEqual(0)
    expect(at('prepareOpenConfig(')).toBeLessThan(at('projectRuntime.close()'))
    expect(at('closeDB()')).toBeLessThan(at('projectRuntime.begin('))
    expect(at('projectRuntime.begin(')).toBeLessThan(at('initDB('))
  })

  it('matches the golden', () => {
    const run = JSON.parse(JSON.stringify(record())) as Recorded
    if (WRITE) {
      fs.writeFileSync(GOLDEN, JSON.stringify(run, null, 1) + '\n')
      return
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Recorded
    for (const k of ['stopProject', 'stopProjectWithRecomputePending', 'openOverAnOpenProject'] as const) {
      expect(run[k], k).toEqual(golden[k])
    }
    expect(run.openFresh.linux, 'openFresh.linux').toEqual(golden.openFresh.linux)
    expect(run.openFresh.darwin, 'openFresh.darwin').toEqual(golden.openFresh.darwin)
  })
})
