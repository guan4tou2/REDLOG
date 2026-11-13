// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import RecordingWorkspace from '../src/renderer/src/components/RecordingWorkspace'

// The stand-in portals a count into the slot the workspace hands it, as
// ActivityResults does, so the row it lands in can be checked here.
vi.mock('../src/renderer/src/components/SearchPanel', async () => {
  const { createPortal } = await import('react-dom')
  return { SearchPanel: ({ controlledQuery, viewMode, active, browse, statsSlot }: any) => <div data-testid="workspace-search" data-active={active} data-mode={viewMode} data-browse={browse}>{controlledQuery}{statsSlot && active ? createPortal(<span data-testid="activity-stats">3 activities</span>, statsSlot) : null}</div> }
})
vi.mock('../src/renderer/src/components/TranscriptView', () => ({ default: ({ reading, externalQuery, active }: any) => <div data-testid={`workspace-${reading}`} data-active={active}><input aria-label={`position-${reading}`} defaultValue="" />{externalQuery}</div> }))
vi.mock('../src/renderer/src/components/SourceSessionPicker', () => ({default: () => null}))
// Stitch 04: the title row reads the project total, capture health and the
// recording state; this suite is about the reading modes, so those answer simply.
vi.mock('../src/renderer/src/lib/useAppCounts', () => ({ useAppCounts: () => ({ eventCount: 3, loggedCount: 1 }) }))
vi.mock('../src/renderer/src/lib/useCaptureHealth', () => ({ useCaptureHealthState: () => ({ health: null, status: 'ok', lastOkAt: null, refresh: () => {} }) }))
beforeEach(() => { (window as any).redlog = { recording: { get: async () => true, onChange: () => () => {} } } })
afterEach(cleanup)

describe('recording workspace', () => {
  it('opens a requested reader without losing its query or mounted reading position', async () => {
    const { rerender } = render(<I18nProvider><RecordingWorkspace onOpenInTimeline={vi.fn()} requestedReading={{ mode: 'io', at: 1 }} /></I18nProvider>)
    expect((await screen.findByRole('tab', { name: 'Input / output' })).getAttribute('aria-selected')).toBe('true')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'saved query' } })
    fireEvent.change(await screen.findByLabelText('position-io'), { target: { value: 'saved position' } })
    rerender(<I18nProvider><RecordingWorkspace onOpenInTimeline={vi.fn()} requestedReading={{ mode: 'ai', at: 2 }} /></I18nProvider>)
    expect((await screen.findByTestId('workspace-ai')).textContent).toContain('saved query')
    rerender(<I18nProvider><RecordingWorkspace onOpenInTimeline={vi.fn()} requestedReading={{ mode: 'io', at: 3 }} /></I18nProvider>)
    expect(screen.getByLabelText('position-io')).toHaveProperty('value', 'saved position')
  })

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

describe('recording workspace density (2026-11-14)', () => {
  it('states the time zone once, for every reading', () => {
    render(<I18nProvider><RecordingWorkspace onOpenInTimeline={vi.fn()} onOpenTimeline={vi.fn()} /></I18nProvider>)
    expect(screen.getAllByText(/Time zone:/)).toHaveLength(1)
    fireEvent.click(screen.getByRole('tab', { name: 'Input / output' }))
    expect(screen.getAllByText(/Time zone:/)).toHaveLength(1)
  })

  it('puts the activity count in the tab row beside the way to the Timeline, outside the tablist', () => {
    render(<I18nProvider><RecordingWorkspace onOpenInTimeline={vi.fn()} onOpenTimeline={vi.fn()} /></I18nProvider>)
    const row = screen.getByTestId('activity-tab-row')
    const stats = screen.getByTestId('activity-stats')
    expect(row.contains(stats)).toBe(true)
    expect(screen.getByRole('tablist').contains(stats)).toBe(false)
    // Right side: after the tabs, before 開啟時間軸.
    const open = screen.getByTestId('workspace-open-timeline')
    expect(stats.compareDocumentPosition(open) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Only while the activity reading is the one shown.
    fireEvent.click(screen.getByRole('tab', { name: 'Input / output' }))
    expect(screen.queryByTestId('activity-stats')).toBeNull()
  })
})
