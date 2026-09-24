// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import CapturePackGroup from '../src/renderer/src/components/settings/CapturePackGroup'
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
