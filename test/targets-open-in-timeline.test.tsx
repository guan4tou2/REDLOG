// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TargetView } from '../src/renderer/src/components/TargetView'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { FilterProvider, useSharedFilter } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { installTimelineBridge, makeEvent, page, type TimelineBridge } from './helpers/timeline-bridge'

let filterApi: ReturnType<typeof useSharedFilter>
function Probe(): null { filterApi = useSharedFilter(); return null }

const T0 = 1_700_000_000_000

// Spec 038 US2: the target picked on the Targets page is the shared target.
// It used to be a Timeline-only "focus" that matched seven observation
// fields and dimmed the rest, beside a FilterBar chip that meant target_id,
// so the Targets count and what the Timeline showed disagreed.
describe('opening a target in the Timeline', () => {
  let b: TimelineBridge
  beforeEach(() => {
    b = installTimelineBridge()
    const events = (window as unknown as { redlog: { events: Record<string, unknown> } }).redlog.events
    events.aggregateTargets = async () => [{ target: '10.0.0.5', eventCount: 3, firstSeen: T0 - 5000, lastSeen: T0 }]
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('sets the shared target, and the Timeline pages through it', async () => {
    const onOpen = vi.fn()
    render(<I18nProvider><FilterProvider><Probe /><TargetView onOpenInTimeline={onOpen} /></FilterProvider></I18nProvider>)
    await screen.findByText('3 events')
    expect(screen.queryByText('3 cmds')).toBeNull()
    const list = await screen.findByRole('listbox')
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0))
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(filterApi.filter.targetId).toBe('10.0.0.5'))
    expect(onOpen).toHaveBeenCalledWith(T0)
    expect(onOpen.mock.calls[0]).toHaveLength(1)
  })

  // T058 (SC-002): a live row joins the Targets list through the page's own
  // predicates. It was `evt.targetId === selected`, which missed the other
  // casing and let in a plumbing row that carried the target.
  it('adds a live row by the one target predicate, housekeeping aside', async () => {
    const events = (window as unknown as { redlog: { events: Record<string, unknown> } }).redlog.events
    events.aggregateTargets = async () => [{ target: 'example.com', eventCount: 1, firstSeen: T0 - 5000, lastSeen: T0 }]
    b.queryPage.mockResolvedValue(page([makeEvent('old', T0 - 5000, 'shell', {
      targetId: 'example.com', data: { subtype: 'command_end', command: 'nmap old' }
    })]))
    render(<I18nProvider><FilterProvider><TargetView /></FilterProvider></I18nProvider>)
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0))
    fireEvent.click(screen.getAllByRole('option')[0])
    await screen.findByText(/^\$ nmap old/)
    expect(b.queryPage.mock.calls.at(-1)?.[0]).toMatchObject({ targetId: 'example.com', excludeHousekeeping: true })
    b.matchIds.mockImplementation(async (req: { ids: string[] }) => req.ids.filter((id) => id === 'live'))
    act(() => b.emitBatch([
      makeEvent('live', T0 + 1000, 'shell', { targetId: 'EXAMPLE.com', data: { subtype: 'command_end', command: 'curl live' } }),
      makeEvent('plumb', T0 + 2000, 'shell', {
        targetId: 'example.com', data: { subtype: 'command_start', command: 'source ~/.redlog/shell-bash-hook.sh' }
      })
    ]))
    expect(await screen.findByText(/^\$ curl live/)).not.toBeNull()
    expect(b.matchIds).toHaveBeenCalledWith(expect.objectContaining({ filter: { targetId: 'example.com' }, excludeHousekeeping: true }))
    expect(screen.queryByText(/shell-bash-hook/)).toBeNull()
  })

  it('has one target control on the Timeline: the shared chip, no focus badge', async () => {
    b.queryPage.mockResolvedValue(page([makeEvent('e1', T0, 'shell', { targetId: '10.0.0.5' })]))
    render(<I18nProvider><FilterProvider><Probe /><TimelinePanel /></FilterProvider></I18nProvider>)
    act(() => { filterApi.setTargetId('10.0.0.5') })
    await waitFor(() => expect(b.queryPage.mock.calls.at(-1)?.[0]).toMatchObject({ targetId: '10.0.0.5' }))
    expect(screen.queryByTestId('timeline-target-focus-badge')).toBeNull()
  })
})

describe('the Targets page as the proposal lays it out', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })
  const setup = (scope: { targets: string[]; excludeTargets: string[] } | 'fail'): void => {
    installTimelineBridge()
    const r = (window as unknown as { redlog: Record<string, Record<string, unknown>> }).redlog
    r.events.aggregateTargets = async () => [
      { target: '10.0.0.5', eventCount: 3, firstSeen: T0 - 5000, lastSeen: T0 },
      { target: 'api.example', eventCount: 2, firstSeen: T0 - 4000, lastSeen: T0 - 1000 }
    ]
    r.config = { get: async () => { if (scope === 'fail') throw new Error('nope'); return { scope } } }
  }
  const mount = (): void => { render(<I18nProvider><FilterProvider><TargetView /></FilterProvider></I18nProvider>) }

  it('never calls a target in or out of scope while no rule is declared', async () => {
    setup({ targets: [], excludeTargets: [] })
    mount()
    await screen.findByText('10.0.0.5')
    expect(screen.getAllByText('Not set')).toHaveLength(2)
    expect(screen.queryByText('Scope unknown')).toBeNull()
    expect(screen.queryByText('In scope')).toBeNull()
    expect((screen.getByRole('button', { name: 'In Scope' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'All' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('judges targets against the declared rules and filters by that judgement', async () => {
    setup({ targets: ['10.0.0.5'], excludeTargets: [] })
    mount()
    await screen.findByText('In scope')
    fireEvent.click(screen.getByRole('button', { name: 'Out of Scope' }))
    expect(screen.queryByText('10.0.0.5')).toBeNull()
    expect(screen.getByText('api.example')).toBeTruthy()
  })

  it('searches targets by host', async () => {
    setup({ targets: ['10.0.0.5'], excludeTargets: [] })
    mount()
    await screen.findByText('10.0.0.5')
    fireEvent.change(screen.getByTestId('targets-search'), { target: { value: 'api' } })
    expect(screen.queryByText('10.0.0.5')).toBeNull()
    expect(screen.getByText('api.example')).toBeTruthy()
    fireEvent.change(screen.getByTestId('targets-search'), { target: { value: 'zzz' } })
    expect(await screen.findByText(/No targets match/)).toBeTruthy()
  })

  it('offers work-on and locate inside the expanded target, not on the row', async () => {
    setup({ targets: ['10.0.0.5'], excludeTargets: [] })
    mount()
    await screen.findByText('10.0.0.5')
    expect(screen.queryByTestId('target-work-on')).toBeNull()
    fireEvent.click(screen.getByText('10.0.0.5'))
    expect(await screen.findByTestId('target-work-on')).toBeTruthy()
  })

  it('calls an unreadable rule set unknown, which is not the same as not set', async () => {
    setup('fail')
    mount()
    await screen.findByText('10.0.0.5')
    expect(screen.getAllByText('Scope unknown')).toHaveLength(2)
    expect(screen.queryByText('Not set')).toBeNull()
  })

  it('says the list is ordered by recent activity', async () => {
    setup({ targets: ['10.0.0.5'], excludeTargets: [] })
    mount()
    expect(await screen.findByText('Most recent activity first')).toBeTruthy()
  })
})
