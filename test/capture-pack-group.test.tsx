// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import CapturePackGroup, { PackMember } from '../src/renderer/src/components/settings/CapturePackGroup'
import type { ConfigState } from '../src/renderer/src/components/settings/SettingsShared'

// Spec 035 — one switch per optional capture pack.
const t = (k: string): string => k
const cfg = (packs: ConfigState['packs']) => ({ packs } as unknown as ConfigState)

describe('CapturePackGroup', () => {
  afterEach(() => cleanup())

  it('turns the pack on for the project, and shows member tuning only while on', () => {
    const seen: ConfigState[] = []
    const { rerender } = render(
      <CapturePackGroup pack="hostMonitors" title="Host" hint="hint" available config={cfg({ hostMonitors: false })} setConfig={(c) => seen.push(c)} t={t}>
        <p>member tuning</p>
      </CapturePackGroup>
    )
    expect(screen.queryByText('member tuning')).toBeNull()
    fireEvent.click(screen.getByTestId('pack-switch-hostMonitors'))
    expect(seen.at(-1)!.packs).toEqual({ hostMonitors: true })
    rerender(
      <CapturePackGroup pack="hostMonitors" title="Host" hint="hint" available config={cfg({ hostMonitors: true })} setConfig={() => {}} t={t}>
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

  it('says a pack disabled in Plugins is removed, instead of offering a switch', () => {
    render(
      <CapturePackGroup pack="aiAgents" title="AI" hint="hint" available={false} config={cfg({ aiAgents: true })} setConfig={() => {}} t={t}>
        <p>member tuning</p>
      </CapturePackGroup>
    )
    expect(screen.getByTestId('pack-removed-aiAgents')).toBeTruthy()
    expect(screen.queryByTestId('pack-switch-aiAgents')).toBeNull()
    expect(screen.queryByText('member tuning')).toBeNull()
  })
})
