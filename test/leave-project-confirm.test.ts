// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfirmOpts } from '../src/renderer/src/components/ConfirmDialog'

// The grade is the point of this module, so it is what the test pins.
//
// `stopProject()` kills every open terminal pane, and that is the part of
// leaving a project that cannot be undone. When there are no panes there is
// nothing unrecoverable to acknowledge, and a checkbox on every return to the
// picker is exactly the friction §5.5 rations — trained away by the fiftieth
// time, and gone on the one that mattered.

const shown: ConfirmOpts[] = []
let answer = true

vi.mock('../src/renderer/src/components/ConfirmDialog', () => ({
  confirmGraded: (opts: ConfirmOpts) => { shown.push(opts); return Promise.resolve(answer) }
}))

const { confirmLeaveProject } = await import('../src/renderer/src/lib/leaveProject')

/** Keys back, so a renamed string cannot quietly pass this. */
const t = (key: string, vars?: Record<string, string | number>): string =>
  vars ? `${key}:${JSON.stringify(vars)}` : key

function installBridge(opts: { panes: number; count: number | 'fail' }): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    terminal: { list: async () => Array.from({ length: opts.panes }, (_v, i) => ({ id: `t${i}` })) },
    events: {
      getCount: async () => {
        if (opts.count === 'fail') throw new Error('db closed')
        return opts.count
      }
    }
  }
}

beforeEach(() => { shown.length = 0; answer = true })
afterEach(() => { delete (window as unknown as { redlog?: unknown }).redlog })

describe('confirmLeaveProject', () => {
  it('asks for an acknowledgement only while panes are open', async () => {
    installBridge({ panes: 2, count: 10 })
    await confirmLeaveProject(t, { projectName: 'acme' })
    expect(shown[0].level).toBe('irreversible')
    expect(shown[0].consequences).toContainEqual(expect.stringContaining('project.leaveTerminals'))
  })

  it('stays plain when nothing unrecoverable is open', async () => {
    installBridge({ panes: 0, count: 10 })
    await confirmLeaveProject(t, { projectName: 'acme' })
    expect(shown[0].level).toBe('plain')
    // The line names a number, so it must not appear saying zero.
    expect(shown[0].consequences).not.toContainEqual(expect.stringContaining('project.leaveTerminals'))
    // The one that is always true is always said.
    expect(shown[0].consequences).toContain('project.leaveNoCapture')
  })

  it('names both projects when it is a switch', async () => {
    installBridge({ panes: 0, count: 3 })
    await confirmLeaveProject(t, { projectName: 'acme', to: 'beta' })
    expect(shown[0].title).toContain('project.switchTitle')
    expect(shown[0].title).toContain('beta')
    expect(shown[0].confirmLabel).toBe('project.switchConfirm')
  })

  it('still asks when the count cannot be read', async () => {
    installBridge({ panes: 1, count: 'fail' })
    await expect(confirmLeaveProject(t, { projectName: 'acme' })).resolves.toBe(true)
    // The uncounted wording, rather than a dialog that never opened or one
    // promising that 0 events were kept.
    expect(shown[0].message).toBe('project.leaveMessage')
  })

  it('passes the operator’s answer back', async () => {
    installBridge({ panes: 0, count: 0 })
    answer = false
    expect(await confirmLeaveProject(t, { projectName: 'acme' })).toBe(false)
  })
})
