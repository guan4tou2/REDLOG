// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import AboutPage from '../src/renderer/src/components/settings/AboutPage'
import type { UpdateStatus } from '../src/main/services/update-status'

// Spec 061 US1: About says what the last check found. A check that failed, or
// found a release with nothing to install, is never shown as "up to date".

const t = (key: string, vars?: Record<string, string | number>): string =>
  vars ? `${key}|${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')}` : key

const base: UpdateStatus = {
  stage: 'idle', method: 'download-page', packaged: true, currentVersion: '1.0.0', targetVersion: null,
  progress: null, result: null, checkedAt: null, releaseUrl: 'https://example.test/releases',
  autoCheck: true, unfinished: false
}

function draw(initial: Partial<UpdateStatus>, platform = 'darwin') {
  let push: (s: UpdateStatus) => void = () => {}
  const app = {
    checkForUpdates: vi.fn(async () => {}),
    updateStatus: vi.fn(async () => ({ ...base, ...initial })),
    onUpdateStatus: vi.fn((cb: (s: UpdateStatus) => void) => { push = cb; return () => {} }),
    cancelUpdate: vi.fn(async () => true),
    installUpdate: vi.fn(async () => {}),
    openExternal: vi.fn(async () => {}),
    setAutoUpdateCheck: vi.fn(async (on: boolean) => ({ ...base, ...initial, autoCheck: on }))
  }
  ;(window as unknown as { redlog: unknown }).redlog = {
    platform,
    app,
    debug: { status: vi.fn(async () => ({ enabled: false, path: '/x' })), set: vi.fn(), reveal: vi.fn() }
  }
  ;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = 'test'
  render(<AboutPage t={t} />)
  return { app, push: (s: Partial<UpdateStatus>) => act(() => push({ ...base, ...initial, ...s })) }
}

afterEach(() => cleanup())

const state = async (): Promise<string> => (await screen.findByTestId('update-state')).textContent ?? ''

describe('About: update status', () => {
  it('says "up to date" only for a check that really found nothing newer', async () => {
    draw({ result: 'upToDate', checkedAt: 1 })
    expect(await state()).toBe('update.state.upToDate')
    expect(screen.getByText(/RedLog v/).textContent).toContain('test-build')
    expect(screen.getByTestId('update-checked-at')).not.toBeNull()
  })

  it('says a failed check failed, and offers a retry and the download page', async () => {
    draw({ stage: 'failed', result: 'failed' })
    expect(await state()).toBe('update.state.failed')
    expect(screen.getByTestId('update-check').textContent).toBe('update.retry')
    fireEvent.click(screen.getByTestId('update-open-page'))
    expect(window.redlog.app.openExternal).toHaveBeenCalledWith('https://example.test/releases')
  })

  it('says a release with no installer for this machine is not an update it can take', async () => {
    draw({ stage: 'unavailable', result: 'noInstaller', targetVersion: '2.0.0' })
    expect(await state()).toBe('update.state.noInstaller|version=2.0.0')
    expect(screen.getByTestId('update-open-page')).not.toBeNull()
  })

  it('says why air-gap made no request, and where to change it', async () => {
    draw({ stage: 'unavailable', result: 'airgap' })
    expect(await state()).toBe('update.state.airgap')
    expect(screen.getByTestId('update-airgap-hint')).not.toBeNull()
    expect(screen.queryByTestId('update-open-page')).toBeNull()
  })

  it('does not let a check start while one runs, and says so', async () => {
    draw({ stage: 'checking' })
    expect(await state()).toBe('update.state.checking')
    const button = screen.getByTestId('update-check') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.textContent).toBe('update.checking')
  })

  it('shows download progress and can cancel it', async () => {
    const { app } = draw({ stage: 'downloading', targetVersion: '2.0.0', progress: 40, method: 'in-app' })
    expect(await state()).toBe('update.state.downloading|version=2.0.0,percent=40')
    fireEvent.click(screen.getByTestId('update-cancel'))
    expect(app.cancelUpdate).toHaveBeenCalled()
  })

  it('keeps a downloaded update findable, and restarts only on its own button', async () => {
    const { app } = draw({ stage: 'ready', targetVersion: '2.0.0', method: 'in-app' })
    expect(await state()).toBe('update.state.ready|version=2.0.0')
    expect(app.installUpdate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('update-install'))
    expect(app.installUpdate).toHaveBeenCalledTimes(1)
  })

  it('follows what main pushes', async () => {
    const { push } = draw({})
    expect(await state()).toBe('update.state.notChecked')
    push({ stage: 'available', targetVersion: '2.0.0' })
    expect(await state()).toBe('update.state.available|version=2.0.0')
  })

  it('names a development build', async () => {
    draw({ packaged: false })
    expect((await screen.findByTestId('update-method')).textContent).toContain('update.devBuild')
  })

  it('says on macOS why the update is by hand, and what to do', async () => {
    draw({}, 'darwin')
    expect((await screen.findByTestId('update-method')).textContent).toContain('update.method.downloadPageMac')
  })

  it('says on Linux that it is by hand and not through a package source', async () => {
    draw({}, 'linux')
    expect((await screen.findByTestId('update-method')).textContent).toContain('update.method.downloadPageLinux')
  })

  it('keeps saying a manual update is not finished, and does not call opening the page an update', async () => {
    draw({ stage: 'available', targetVersion: '2.0.0', unfinished: true })
    expect(await state()).toBe('update.state.unfinished|version=2.0.0')
  })

  it('shows the launch check as on, and turns it off with main having the last word', async () => {
    const { app } = draw({})
    const box = (await screen.findByTestId('update-auto-check')) as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    expect(app.setAutoUpdateCheck).toHaveBeenCalledWith(false)
    await vi.waitFor(() => expect(box.checked).toBe(false))
  })
})
