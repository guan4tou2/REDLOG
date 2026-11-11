// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../src/renderer/src/i18n'
import { ToastContainer } from '../src/renderer/src/components/Toast'
import { leaveProject } from '../src/renderer/src/lib/pendingSaves'

// project.close can reject after main has already torn the runtime down
// (stopProject rethrows its first cleanup error). The title-bar close used to
// have no catch, so the window stayed in the project and nothing said why.

const t = (k: string): string => k
let close: () => Promise<boolean>
let active: () => Promise<unknown>

beforeEach(() => {
  close = async () => true
  active = async () => null
  ;(window as unknown as { redlog: unknown }).redlog = { project: { close: () => close(), active: () => active() } }
  render(<I18nProvider><ToastContainer /></I18nProvider>)
})
afterEach(() => cleanup())

describe('leaving the project', () => {
  it('goes to the picker on a clean close', async () => {
    const onLeft = vi.fn()
    await leaveProject(t, onLeft)
    expect(onLeft).toHaveBeenCalledTimes(1)
  })

  it('goes to the picker and says so when close rejected but nothing is open any more', async () => {
    close = async () => { throw new Error('cleanup failed') }
    const onLeft = vi.fn()
    await leaveProject(t, onLeft)
    expect(onLeft).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('app.closeFinishedWithError')).toBeTruthy()
  })

  it('stays and says so when close rejected and the project is still open', async () => {
    close = async () => { throw new Error('busy') }
    active = async () => ({ id: 'p', name: 'P', createdAt: 1 })
    const onLeft = vi.fn()
    await leaveProject(t, onLeft)
    expect(onLeft).not.toHaveBeenCalled()
    expect(await screen.findByText('app.closeFailed')).toBeTruthy()
  })

  it('stays when it cannot tell whether a project is still open', async () => {
    close = async () => { throw new Error('busy') }
    active = async () => { throw new Error('ipc down') }
    const onLeft = vi.fn()
    await leaveProject(t, onLeft)
    expect(onLeft).not.toHaveBeenCalled()
  })
})
