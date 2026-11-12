// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptureHealthCard } from '../src/renderer/src/components/CaptureHealth'
import { I18nProvider } from '../src/renderer/src/i18n'

// #688: a missing prerequisite is said on its source's row, in the row's error
// line, with the one action that fixes it. `unknown` draws nothing.

const PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
const bridge = {
  openPrerequisiteFix: vi.fn(async () => ({ ok: true })),
  writeText: vi.fn(async () => true)
}

const health = (sources: Array<Partial<CaptureSourceInfo>>): CaptureHealthInfo => ({
  verdict: 'partial', hasRecorded: true, lastEventAt: null, checkedAt: Date.now(),
  dbErrorTotal: 0, dbErrorFirstAt: null,
  sources: sources.map((s) => ({ lastEventAt: null, state: 'ready', ...s }))
} as unknown as CaptureHealthInfo)

const show = (capture: CaptureHealthInfo): void => {
  render(<I18nProvider><CaptureHealthCard capture={capture} onNavigate={() => {}} onRefresh={() => {}} /></I18nProvider>)
}

beforeEach(() => {
  bridge.openPrerequisiteFix.mockClear(); bridge.writeText.mockClear()
  ;(window as unknown as { redlog: unknown }).redlog = {
    capture: { openPrerequisiteFix: bridge.openPrerequisiteFix },
    clipboard: { writeText: bridge.writeText }
  }
})
afterEach(cleanup)

describe('capture card — prerequisites', () => {
  it('shows a missing Screen Recording permission on the screenshot row, and opens its pane', async () => {
    show(health([{
      id: 'screenshot', state: 'error',
      lastError: { at: Date.now(), message: 'Screen Recording permission is not granted; nothing was recorded' },
      prerequisites: [{ id: 'screen-recording', state: 'missing', fix: { kind: 'open', url: PANE } }]
    }]))
    expect(screen.getByTestId('capture-prereq-screenshot').textContent).toMatch(/Screen Recording/)
    // The prerequisite replaces the raw error line rather than repeating it.
    expect(screen.queryByText(/nothing was recorded/)).toBeNull()
    fireEvent.click(screen.getByTestId('capture-prereq-fix-screenshot'))
    await waitFor(() => expect(bridge.openPrerequisiteFix).toHaveBeenCalledWith(PANE))
  })

  it('copies the install command for a missing command', async () => {
    show(health([{
      id: 'connection-monitor', state: 'error', configPath: 'packMembers.connectionMonitor',
      prerequisites: [{ id: 'ss', state: 'missing', fix: { kind: 'copy', command: 'sudo apt install iproute2' } }]
    }]))
    expect(screen.getByTestId('capture-prereq-connection-monitor').textContent).toMatch(/ss/)
    fireEvent.click(screen.getByTestId('capture-prereq-fix-connection-monitor'))
    await waitFor(() => expect(bridge.writeText).toHaveBeenCalledWith('sudo apt install iproute2'))
  })

  it('draws nothing for an unknown prerequisite', () => {
    show(health([
      { id: 'screenshot', state: 'error', lastError: { at: Date.now(), message: 'grab failed' },
        prerequisites: [{ id: 'screen-recording', state: 'unknown' }] }
    ]))
    expect(screen.queryByTestId('capture-prereq-screenshot')).toBeNull()
    expect(screen.queryByTestId('capture-prereq-fix-screenshot')).toBeNull()
    expect(screen.getByText('grab failed')).toBeTruthy()
  })
})
