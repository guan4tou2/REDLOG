// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import RecordingWorkspace from '../src/renderer/src/components/RecordingWorkspace'

vi.mock('../src/renderer/src/components/SearchPanel', () => ({ SearchPanel: ({ controlledQuery, viewMode, active, browse }: any) => <div data-testid="workspace-search" data-active={active} data-mode={viewMode} data-browse={browse}>{controlledQuery}</div> }))
vi.mock('../src/renderer/src/components/TranscriptView', () => ({ default: ({ reading, externalQuery, active }: any) => <div data-testid={`workspace-${reading}`} data-active={active}><input aria-label={`position-${reading}`} defaultValue="" />{externalQuery}</div> }))
vi.mock('../src/renderer/src/components/SourceSessionPicker', () => ({default: () => null}))
// Stitch 04: the title row reads the project total, capture health and the
// recording state; this suite is about the reading modes, so those answer simply.
vi.mock('../src/renderer/src/lib/useAppCounts', () => ({ useAppCounts: () => ({ eventCount: 3, loggedCount: 1 }) }))
vi.mock('../src/renderer/src/lib/useCaptureHealth', () => ({ useCaptureHealthState: () => ({ health: null, status: 'ok', lastOkAt: null, refresh: () => {} }) }))
beforeEach(() => { (window as any).redlog = { recording: { get: async () => true, onChange: () => () => {} } } })
afterEach(cleanup)

describe('recording workspace', () => {
  // The Timeline is the other reading of the same material and had no way in
  // except the command palette. The entry lives beside the reading tabs, so it
  // is on screen whichever reading is open.
  it('offers a way into the timeline, and hides it when there is no destination', () => {
    const onOpenTimeline = vi.fn()
    const { unmount } = render(<I18nProvider><RecordingWorkspace onOpenInTimeline={vi.fn()} onOpenTimeline={onOpenTimeline} /></I18nProvider>)
    fireEvent.click(screen.getByRole('button', { name: /Open timeline/ }))
    expect(onOpenTimeline).toHaveBeenCalledTimes(1)
    unmount()
    render(<I18nProvider><RecordingWorkspace onOpenInTimeline={vi.fn()} /></I18nProvider>)
    expect(screen.queryByRole('button', { name: /Open timeline/ })).toBeNull()
  })

  it('shares the query across reading modes and preserves a mounted reader when returning', async () => {
    render(<I18nProvider><RecordingWorkspace onOpenInTimeline={vi.fn()} /></I18nProvider>)
    expect(screen.getByTestId('workspace-search').dataset.mode).toBe('activities')
    expect(screen.getByTestId('workspace-search').dataset.browse).toBe('true')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'sqlmap' } })
    expect(screen.getByTestId('workspace-search').textContent).toBe('sqlmap')
    fireEvent.click(screen.getByRole('tab', { name: 'Input / output' }))
    const position = await screen.findByLabelText('position-io')
    fireEvent.change(position, { target: { value: 'saved position' } })
    fireEvent.click(screen.getByRole('tab', { name: 'AI conversations' }))
    expect((await screen.findByTestId('workspace-ai')).textContent).toContain('sqlmap')
    fireEvent.click(screen.getByRole('tab', { name: 'Input / output' }))
    expect(screen.getByLabelText('position-io')).toHaveProperty('value', 'saved position')
    fireEvent.click(screen.getByRole('tab', { name: 'Raw events' }))
    expect(screen.getByTestId('workspace-search').dataset.mode).toBe('events')
    expect(screen.getByTestId('workspace-io').dataset.active).toBe('false')
  })
})

describe('recording workspace title row (Stitch 04)', () => {
  it('says the recording state and the project total, and that each source answers for itself', async () => {
    render(<I18nProvider><RecordingWorkspace onOpenInTimeline={vi.fn()} /></I18nProvider>)
    const pill = screen.getByTestId('activity-recording')
    expect(pill.textContent).toContain('4 events')
    expect(pill.textContent).toContain('each source confirmed on its own')
    expect(await screen.findByText('Recording')).toBeTruthy()
  })
})
