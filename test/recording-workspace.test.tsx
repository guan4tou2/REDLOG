// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import RecordingWorkspace from '../src/renderer/src/components/RecordingWorkspace'

// The stand-in portals a count into the slot the workspace hands it, as
// ActivityResults does, so the row it lands in can be checked here.
vi.mock('../src/renderer/src/components/SearchPanel', async () => {
  const { createPortal } = await import('react-dom')
  return { SearchPanel: ({ controlledQuery, viewMode, active, browse, statsSlot, locateEventId, onLocateEnd }: any) => <div data-testid="workspace-search" data-active={active} data-mode={viewMode} data-browse={browse} data-locate={locateEventId}>{controlledQuery}<button data-testid="stand-in-close-located" aria-label="close located" onClick={onLocateEnd} />{statsSlot && active ? createPortal(<span data-testid="activity-stats">3 activities</span>, statsSlot) : null}</div> }
})
vi.mock('../src/renderer/src/components/TranscriptView', () => ({ default: ({ reading, externalQuery, active }: any) => <div data-testid={`workspace-${reading}`} data-active={active}><input aria-label={`position-${reading}`} defaultValue="" />{externalQuery}</div> }))
vi.mock('../src/renderer/src/components/SourceSessionPicker', () => ({default: () => null}))
// The title row reads capture health for a failing source; null unless a test sets one.
const capture = vi.hoisted(() => ({ health: null as unknown }))
vi.mock('../src/renderer/src/lib/useCaptureHealth', () => ({ useCaptureHealthState: () => ({ health: capture.health, status: 'ok', lastOkAt: null, refresh: () => {} }) }))
// The page's source choice is the filter context's one agent type.
const source = vi.hoisted(() => ({ agentType: null as string | null, set: (_: string | null) => {} }))
vi.mock('../src/renderer/src/lib/FilterContext', () => ({ useSharedFilter: () => ({ filter: { agentType: source.agentType }, setAgentType: (v: string | null) => source.set(v), knownAgentTypes: ['shell', 'agent', 'dns'] }) }))
beforeEach(() => { (window as any).redlog = { recording: { get: async () => true, onChange: () => () => {} } } })
afterEach(() => { cleanup(); capture.health = null; source.agentType = null; source.set = () => {} })

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

describe('recording workspace title row (2026-11-14)', () => {
  // The status bar says recording and the project's event count on every
  // page; the chip beside the title said the same two things again, plus a
  // caption, and did nothing when clicked.
  it('has no recording chip: the title shares one row with the search and the source', () => {
    render(<I18nProvider><RecordingWorkspace onOpenInTimeline={vi.fn()} /></I18nProvider>)
    expect(screen.queryByTestId('activity-recording')).toBeNull()
    const row = screen.getByTestId('activity-title-row')
    for (const id of ['activity-title', 'search-input', 'activity-source']) {
      expect(row.contains(screen.getByTestId(id)), id).toBe(true)
    }
    expect(row.className).toContain('flex-wrap')
  })

  it('keeps the one thing the chip row had that nothing else on the page says: a failing source', () => {
    capture.health = { sources: [{ id: 'mitmproxy', label: 'HTTP proxy', state: 'error' }] }
    render(<I18nProvider><RecordingWorkspace onOpenInTimeline={vi.fn()} /></I18nProvider>)
    const alert = screen.getByTestId('activity-source-alert')
    expect(alert.textContent).toContain('HTTP proxy')
    expect(screen.getByTestId('activity-title-row').contains(alert)).toBe(true)
  })
})

// 2026-11-18: the source <select> became one button per kind the page can map
// to a single agent type. HTTP has none: proxy traffic is `scanner`, which
// also holds connection and C2 rows, and browser navigation is its own type.
describe('recording workspace source kinds (2026-11-18)', () => {
  const kinds = (): HTMLElement[] => Array.from(screen.getByTestId('activity-source').querySelectorAll('button'))
  it('offers commands, AI, files and marks as single-select buttons, none pressed when nothing is chosen', () => {
    render(<I18nProvider><RecordingWorkspace onOpenInTimeline={vi.fn()} /></I18nProvider>)
    expect(screen.getByTestId('activity-source').getAttribute('role')).toBe('group')
    expect(screen.queryByRole('combobox', { name: 'Source' })).toBeNull()
    expect(kinds().map((b) => b.textContent)).toEqual(['Commands', 'AI', 'Files', 'Markers'])
    expect(kinds().map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false', 'false'])
  })

  it('sets the one source the filter holds, and pressing the active one clears it', () => {
    const set = vi.fn()
    source.set = set
    const { unmount } = render(<I18nProvider><RecordingWorkspace onOpenInTimeline={vi.fn()} /></I18nProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Commands' }))
    expect(set).toHaveBeenLastCalledWith('shell')
    fireEvent.click(screen.getByRole('button', { name: 'Files' }))
    expect(set).toHaveBeenLastCalledWith('file_transfer')
    unmount()
    source.agentType = 'agent'
    render(<I18nProvider><RecordingWorkspace onOpenInTimeline={vi.fn()} /></I18nProvider>)
    expect(screen.getByRole('button', { name: 'AI' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'AI' }))
    expect(set).toHaveBeenLastCalledWith(null)
  })

  it('presses none of them for a source that is not one of the four', () => {
    source.agentType = 'dns'
    render(<I18nProvider><RecordingWorkspace onOpenInTimeline={vi.fn()} /></I18nProvider>)
    expect(kinds().map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false', 'false'])
  })
})

describe('recording workspace density (2026-11-14)', () => {
  // 2026-11-18: the zone is the status bar's, once for every page and reading.
  it('does not state the time zone in the page header', () => {
    render(<I18nProvider><RecordingWorkspace onOpenInTimeline={vi.fn()} onOpenTimeline={vi.fn()} /></I18nProvider>)
    expect(screen.queryByText(/Time zone/)).toBeNull()
    expect(screen.queryByText(/\(UTC[+-]/)).toBeNull()
    expect(screen.queryByTestId('activity-zone')).toBeNull()
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

// Arriving from a Timeline event puts `event:<id>` in the box so the page reads
// the activity that holds it. It is borrowed: the operator's own query comes
// back when they leave the located record, and is never overwritten for good.
describe('recording workspace arrival from a Timeline event', () => {
  const arrival = (at: number, id = 'E1') => ({ text: `event:${id}`, at, eventId: id })
  const box = (): HTMLInputElement => screen.getByRole('searchbox') as HTMLInputElement
  const located = (): string | undefined => screen.getByTestId('workspace-search').dataset.locate
  const mount = (props: Record<string, unknown> = {}) => {
    const ui = (extra: Record<string, unknown>) => <I18nProvider><RecordingWorkspace onOpenInTimeline={vi.fn()} {...props} {...extra} /></I18nProvider>
    const view = render(ui({}))
    return { ...view, show: (extra: Record<string, unknown>) => view.rerender(ui(extra)) }
  }

  it('asks the list to open the located record, and shows the query that finds it', () => {
    const { show } = mount()
    show({ externalQuery: arrival(1) })
    expect(box().value).toBe('event:E1')
    expect(located()).toBe('E1')
  })

  it('gives the operator\'s own query back when the located record is closed', () => {
    const { show } = mount()
    fireEvent.change(box(), { target: { value: 'sqlmap' } })
    show({ externalQuery: arrival(1) })
    expect(box().value).toBe('event:E1')
    fireEvent.click(screen.getByTestId('stand-in-close-located'))
    expect(box().value).toBe('sqlmap')
    expect(located()).toBeUndefined()
  })

  it('gives it back when the operator leaves the page, so the way back finds what they had', () => {
    const { show } = mount()
    fireEvent.change(box(), { target: { value: 'sqlmap' } })
    show({ externalQuery: arrival(1), active: true })
    show({ externalQuery: arrival(1), active: false })
    expect(box().value).toBe('sqlmap')
    expect(located()).toBeUndefined()
  })

  it('keeps the first query across a second arrival that did not leave in between', () => {
    const { show } = mount()
    fireEvent.change(box(), { target: { value: 'sqlmap' } })
    show({ externalQuery: arrival(1) })
    show({ externalQuery: arrival(2, 'E2') })
    expect(located()).toBe('E2')
    fireEvent.click(screen.getByTestId('stand-in-close-located'))
    expect(box().value).toBe('sqlmap')
  })

  it('lets go once the operator types: their text is theirs, nothing is restored over it', () => {
    const { show } = mount()
    fireEvent.change(box(), { target: { value: 'sqlmap' } })
    show({ externalQuery: arrival(1) })
    fireEvent.change(box(), { target: { value: 'event:E1 nmap' } })
    expect(located()).toBeUndefined()
    show({ externalQuery: arrival(1), active: false })
    expect(box().value).toBe('event:E1 nmap')
  })

  it('restores an empty box as empty', () => {
    const { show } = mount()
    show({ externalQuery: arrival(1) })
    fireEvent.click(screen.getByTestId('stand-in-close-located'))
    expect(box().value).toBe('')
  })
})
