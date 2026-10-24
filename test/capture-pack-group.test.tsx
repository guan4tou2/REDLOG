// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import CapturePackGroup, { PackMember } from '../src/renderer/src/components/settings/CapturePackGroup'
import type { ConfigState } from '../src/renderer/src/components/settings/SettingsShared'

// Spec 035 — one switch per optional capture pack.
const t = (k: string): string => k
const cfg = (packs: ConfigState['packs']) => ({ packs } as unknown as ConfigState)

describe('CapturePackGroup', () => {
  beforeEach(() => Object.assign(window, { redlog: { plugins: {
    list: vi.fn(async () => [{ id: 'pack-host-monitors', source: 'bundled', status: 'active' }]),
    setEnabled: vi.fn(async () => [])
  } } }))
  afterEach(() => cleanup())

  it('turns the pack on for the project, and shows member tuning only while on', async () => {
    const seen: ConfigState[] = []
    const { rerender } = render(
      <CapturePackGroup pack="hostMonitors" title="Host" hint="hint" config={cfg({ hostMonitors: false })} setConfig={(c) => seen.push(c)} t={t}>
        <p>member tuning</p>
      </CapturePackGroup>
    )
    expect(screen.queryByText('member tuning')).toBeNull()
    fireEvent.click(await screen.findByTestId('pack-switch-hostMonitors'))
    expect(seen.at(-1)!.packs).toEqual({ hostMonitors: true })
    rerender(
      <CapturePackGroup pack="hostMonitors" title="Host" hint="hint" config={cfg({ hostMonitors: true })} setConfig={() => {}} t={t}>
        <p>member tuning</p>
      </CapturePackGroup>
    )
    expect(screen.getByText('member tuning')).toBeTruthy()
  })

  it('leaves the clipboard unticked until the operator ticks it (#224)', () => {
    // A pack is a preset, not an atom. The clipboard samples whatever the
    // operator copies anywhere on the machine for the length of the
    // engagement, so turning "host monitors" on must not also start it.
    const seen: ConfigState[] = []
    const { rerender } = render(
      <PackMember member="clipboard" title="Clipboard" hint="hint" warn="in or out of scope"
        config={{ packMembers: {} } as unknown as ConfigState} setConfig={(c) => seen.push(c)} t={t}>
        <p>clipboard tuning</p>
      </PackMember>
    )
    expect((screen.getByTestId('pack-member-clipboard') as HTMLInputElement).checked).toBe(false)
    expect(screen.getByTestId('pack-member-optin-clipboard')).toBeTruthy()
    // Tuning for something that is not running is the same lie the pack
    // switch already avoids.
    expect(screen.queryByText('clipboard tuning')).toBeNull()
    // What it costs is said where it is turned on.
    expect(screen.getByText('in or out of scope')).toBeTruthy()

    fireEvent.click(screen.getByTestId('pack-member-clipboard'))
    expect(seen.at(-1)!.packMembers).toEqual({ clipboard: true })

    rerender(
      <PackMember member="clipboard" title="Clipboard" hint="hint"
        config={{ packMembers: { clipboard: true } } as unknown as ConfigState} setConfig={() => {}} t={t}>
        <p>clipboard tuning</p>
      </PackMember>
    )
    expect(screen.getByText('clipboard tuning')).toBeTruthy()
    expect(screen.queryByTestId('pack-member-optin-clipboard')).toBeNull()
  })

  it('lets an ordinary member be dropped without losing the pack', () => {
    const seen: ConfigState[] = []
    render(
      <PackMember member="processMonitor" title="Processes" hint="hint"
        config={{ packMembers: {} } as unknown as ConfigState} setConfig={(c) => seen.push(c)} t={t}>
        <p>process tuning</p>
      </PackMember>
    )
    expect((screen.getByTestId('pack-member-processMonitor') as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText('process tuning')).toBeTruthy()
    fireEvent.click(screen.getByTestId('pack-member-processMonitor'))
    expect(seen.at(-1)!.packMembers).toEqual({ processMonitor: false })
  })

  it('says a pack disabled in Plugins is removed, instead of offering a switch', async () => {
    vi.mocked(window.redlog.plugins.list).mockResolvedValue([{ id: 'pack-host-monitors', source: 'bundled', status: 'disabled' }])
    render(
      <CapturePackGroup pack="hostMonitors" title="AI" hint="hint" config={cfg({ hostMonitors: true })} setConfig={() => {}} t={t}>
        <p>member tuning</p>
      </CapturePackGroup>
    )
    expect(await screen.findByTestId('pack-removed-hostMonitors')).toBeTruthy()
    expect(screen.queryByTestId('pack-switch-hostMonitors')).toBeNull()
    expect(screen.queryByText('member tuning')).toBeNull()
  })

  // #435: the row that says the pack is disabled offers the way back, so the
  // operator does not have to find the page themselves.
  it('offers the direct route to plugin settings when the pack is disabled there', async () => {
    vi.mocked(window.redlog.plugins.list).mockResolvedValue([{ id: 'pack-host-monitors', source: 'bundled', status: 'disabled' }])
    const onOpenPlugins = vi.fn()
    render(
      <CapturePackGroup pack="hostMonitors" title="AI" hint="hint" config={cfg({ hostMonitors: true })} setConfig={() => {}} t={t} onOpenPlugins={onOpenPlugins}>
        <p>member tuning</p>
      </CapturePackGroup>
    )
    fireEvent.click(await screen.findByTestId('pack-open-plugins-hostMonitors'))
    expect(onOpenPlugins).toHaveBeenCalledTimes(1)
  })

  it('offers no route when there is nowhere to go', async () => {
    vi.mocked(window.redlog.plugins.list).mockResolvedValue([{ id: 'pack-host-monitors', source: 'bundled', status: 'disabled' }])
    render(
      <CapturePackGroup pack="hostMonitors" title="AI" hint="hint" config={cfg({ hostMonitors: true })} setConfig={() => {}} t={t}>
        <p>member tuning</p>
      </CapturePackGroup>
    )
    expect(screen.queryByTestId('pack-open-plugins-hostMonitors')).toBeNull()
  })
  it('keeps loading and failed reads from offering a project recording switch; retry recovers', async () => {
    vi.mocked(window.redlog.plugins.list).mockRejectedValueOnce(new Error('registry unreadable'))
    render(<CapturePackGroup pack="hostMonitors" title="Host" hint="hint" config={cfg({ hostMonitors: true })} setConfig={vi.fn()} t={t}><p>member tuning</p></CapturePackGroup>)
    expect(screen.queryByTestId('pack-switch-hostMonitors')).toBeNull()
    expect((await screen.findByRole('alert')).textContent).toContain('registry unreadable')
    expect(screen.queryByText('member tuning')).toBeNull()
    fireEvent.click(screen.getByText('common.retry'))
    await screen.findByTestId('pack-switch-hostMonitors')
    expect(screen.getByText('member tuning')).toBeTruthy()
  })
  it('restores only the disabled bundled integration, leaving project permissions untouched', async () => {
    vi.mocked(window.redlog.plugins.list).mockResolvedValueOnce([{ id: 'pack-host-monitors', source: 'bundled', status: 'disabled' }])
    const setConfig = vi.fn()
    render(<CapturePackGroup pack="hostMonitors" title="Host" hint="hint" config={cfg({ hostMonitors: false })} setConfig={setConfig} t={t}><p>member tuning</p></CapturePackGroup>)
    fireEvent.click(await screen.findByTestId('pack-repair-hostMonitors'))
    await waitFor(() => expect(window.redlog.plugins.setEnabled).toHaveBeenCalledWith('pack-host-monitors', true))
    const control = await screen.findByTestId('pack-switch-hostMonitors') as HTMLInputElement
    expect(control.checked).toBe(false)
    expect(setConfig).not.toHaveBeenCalled()
    expect(screen.queryByText('member tuning')).toBeNull()
  })
  it('does not pretend a missing or untrusted integration can be enabled', async () => {
    vi.mocked(window.redlog.plugins.list).mockResolvedValue([{ id: 'pack-host-monitors', source: 'user', status: 'disabled' }])
    render(<CapturePackGroup pack="hostMonitors" title="Host" hint="hint" config={cfg({ hostMonitors: false })} setConfig={vi.fn()} t={t} />)
    await screen.findByText('settings.packUnavailable')
    expect(screen.queryByTestId('pack-repair-hostMonitors')).toBeNull()
    expect(screen.queryByTestId('pack-switch-hostMonitors')).toBeNull()
  })

  it('refreshes integration state on return without changing project capture or restoring it', async () => {
    const setConfig = vi.fn()
    render(<CapturePackGroup pack="hostMonitors" title="Host" hint="hint" config={cfg({ hostMonitors: true })} setConfig={setConfig} t={t} />)
    await screen.findByTestId('pack-switch-hostMonitors')
    vi.mocked(window.redlog.plugins.list).mockResolvedValue([{ id: 'pack-host-monitors', source: 'bundled', status: 'disabled' }])
    fireEvent(window, new Event('focus'))
    fireEvent(document, new Event('visibilitychange'))
    await screen.findByTestId('pack-removed-hostMonitors')
    expect(screen.queryByTestId('pack-switch-hostMonitors')).toBeNull()
    expect(window.redlog.plugins.list).toHaveBeenCalledTimes(2)
    expect(window.redlog.plugins.setEnabled).not.toHaveBeenCalled()
    expect(setConfig).not.toHaveBeenCalled()
  })

})
