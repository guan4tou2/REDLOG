// @vitest-environment jsdom
//
// The Timeline's bottom bar and the click contract that goes with it (spec 069
// FR-008): one click selects and shows the bar; a double-click, Enter or the
// bar's Details button opens the body; arriving from another page opens it.
// The bar states only facts the event carries.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { TimelineDetailBar } from '../src/renderer/src/components/timeline/TimelineDetailBar'
import type { RedLogEvent } from '../src/core/db/event-types'
import { installTimelineBridge, makeEvent, page, type TimelineBridge } from './helpers/timeline-bridge'

const t = (k: string, v?: Record<string, unknown>): string => (v ? `${k} ${JSON.stringify(v)}` : k)

const ev = (agentType: string, data: Record<string, unknown>, targetId: string | null = null): RedLogEvent => ({
  id: 'x1', timestamp: 1_700_000_000_000, engagementId: 'e', sessionId: 's', operatorId: 'op',
  agentType, hostname: 'h', sourceIP: null, targetId, data, createdAt: 1_700_000_000_000
} as RedLogEvent)

type BarProps = Parameters<typeof TimelineDetailBar>[0]
function drawBar(event: RedLogEvent, over: Partial<BarProps> = {}): { toggle: () => void; reader: () => void; open: ReturnType<typeof vi.fn> } {
  const toggle = vi.fn(); const reader = vi.fn(); const open = vi.fn()
  render(
    <TimelineDetailBar
      event={event} pluginTypes={[]} titleOf={(e) => String(e.data?.command ?? e.id)} t={t}
      onStep={vi.fn()} canStepPrev canStepNext onOpenInActivity={open}
      bodyOpen={false} onToggleBody={toggle} onOpenReader={reader} {...over}
    />
  )
  return { toggle, reader, open }
}

const setPolicy = (policy: unknown, fail = false): void => {
  ;(window as unknown as { redlog: unknown }).redlog = {
    scope: { policy: vi.fn(async () => { if (fail) throw new Error('nope'); return policy }) },
    clipboard: { writeText: vi.fn(async () => true) }
  }
}

beforeEach(() => { try { localStorage.clear() } catch { /* ignore */ } })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('bar facts', () => {
  it('names the time, the lane and the title, and only the facts the event has', () => {
    setPolicy({ targets: [], excludeTargets: [] })
    drawBar(ev('shell', { subtype: 'command_end', command: 'nmap -sV', exit_code: 0, duration_sec: 4.2 }))
    expect(screen.getByTestId('timeline-bar-title').textContent).toBe('nmap -sV')
    const facts = screen.getByTestId('timeline-bar-facts').textContent!
    expect(facts).toContain('timeline.detail.exit')
    expect(facts).toContain('4.2 s')
    expect(facts).not.toContain('PID')
    expect(facts).not.toContain('timeline.detail.target')
  })

  it('shows PID only when the event records one', () => {
    setPolicy({ targets: [], excludeTargets: [] })
    drawBar(ev('shell', { subtype: 'command_end', command: 'id', exit_code: 1, pid: 49102 }))
    expect(screen.getByTestId('timeline-bar-facts').textContent).toContain('PID: 49102')
    cleanup()
    drawBar(ev('shell', { subtype: 'command_end', command: 'id', exit_code: 1 }))
    expect(screen.getByTestId('timeline-bar-facts').textContent).not.toContain('PID')
  })

  it('has no facts row for an event with nothing to state', () => {
    setPolicy({ targets: [], excludeTargets: [] })
    drawBar(ev('marker', { title: 'note' }))
    expect(screen.queryByTestId('timeline-bar-facts')).toBeNull()
  })

  it.each([
    ['in scope', { targets: ['10.0.0.0/24'], excludeTargets: [] }, '10.0.0.5', 'targets.inScope'],
    ['out of scope', { targets: ['10.0.0.0/24'], excludeTargets: [] }, '8.8.8.8', 'httpScope.out-of-scope'],
    ['excluded', { targets: ['10.0.0.0/24'], excludeTargets: ['10.0.0.5'] }, '10.0.0.5', 'httpScope.out-of-scope'],
    ['no scope set (never out of scope)', { targets: [], excludeTargets: [] }, '8.8.8.8', 'timeline.bar.scopeUnjudged']
  ])('judges the target by the current Scope: %s', async (_n, policy, target, state) => {
    setPolicy(policy)
    drawBar(ev('shell', { subtype: 'command_end', command: 'x', exit_code: 0 }, target))
    await waitFor(() => expect(screen.getByTestId('timeline-bar-facts').textContent).toContain(`timeline.bar.scope {"state":"${state}"}`))
    expect(screen.getByTestId('timeline-bar-facts').textContent).toContain(target)
  })

  it('says the scope is unknown when it cannot be read, and states no verdict before it is read', async () => {
    setPolicy(null, true)
    drawBar(ev('shell', { subtype: 'command_end', command: 'x', exit_code: 0 }, '8.8.8.8'))
    expect(screen.getByTestId('timeline-bar-facts').textContent).not.toContain('timeline.bar.scope')
    await waitFor(() => expect(screen.getByTestId('timeline-bar-facts').textContent).toContain('httpScope.unknown'))
  })
})

describe('bar actions', () => {
  const refd = { subtype: 'command_end', command: 'x', stdout_ref: { sha256: 'a', size: 9, file: 'f', encoding: 'text' } }

  it('wires Details, copy reference and the activity link; the Reader only where there is content to read', () => {
    setPolicy({ targets: [], excludeTargets: [] })
    const { toggle, reader, open } = drawBar(ev('shell', refd))
    fireEvent.click(screen.getByTestId('detail-toggle-body'))
    expect(toggle).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('detail-open-reader'))
    expect(reader).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('detail-open-activity'))
    expect(open).toHaveBeenCalledWith('x1', 1_700_000_000_000)
    expect(screen.getByTestId('detail-copy-ref')).not.toBeNull()
  })

  it.each([
    ['a marker', ev('marker', { title: 'n' })],
    ['a command with no saved output', ev('shell', { subtype: 'command_end', command: 'x', stdout: 'short' })],
    ['a scanner gap', ev('scanner', { subtype: 'capture_gap' })],
    ['an HTTP response whose body is shown inline', ev('scanner', { subtype: 'http_response', response_body: { data: 'hi', encoding: 'text' } })]
  ])('offers no Reader for %s', (_n, event) => {
    setPolicy({ targets: [], excludeTargets: [] })
    drawBar(event)
    expect(screen.queryByTestId('detail-open-reader')).toBeNull()
  })

  it('offers the Reader for an HTTP body that is only saved', () => {
    setPolicy({ targets: [], excludeTargets: [] })
    drawBar(ev('scanner', { subtype: 'http_response', response_body_ref: { sha256: 'a', size: 1, file: 'f', encoding: 'text' } }))
    expect(screen.getByTestId('detail-open-reader')).not.toBeNull()
  })

  it('reads the scope again when it changes, and not at all for an event with no target', async () => {
    const batch: { cb: (e: unknown[]) => void } = { cb: () => {} }
    const policy = vi.fn(async () => ({ targets: ['10.0.0.0/24'], excludeTargets: [] }))
    ;(window as unknown as { redlog: unknown }).redlog = {
      scope: { policy }, events: { onNewBatch: (cb: (e: unknown[]) => void) => { batch.cb = cb; return () => {} } }
    }
    drawBar(ev('shell', { subtype: 'command_end', command: 'x' }, '10.0.0.5'))
    await waitFor(() => expect(policy).toHaveBeenCalledTimes(1))
    act(() => batch.cb([{ data: { subtype: 'scope_recomputed' } }]))
    await waitFor(() => expect(policy).toHaveBeenCalledTimes(2))
    cleanup()
    drawBar(ev('shell', { subtype: 'command_end', command: 'x' }))
    await new Promise((r) => setTimeout(r, 20))
    expect(policy).toHaveBeenCalledTimes(2)
  })

  it('Details reports whether the body is open', () => {
    setPolicy({ targets: [], excludeTargets: [] })
    drawBar(ev('shell', { subtype: 'command_end', command: 'x' }), { bodyOpen: true })
    expect(screen.getByTestId('detail-toggle-body').getAttribute('aria-expanded')).toBe('true')
  })
})

describe('click contract on the track', () => {
  const T0 = 1_700_000_000_000
  let b: TimelineBridge
  const mount = (): void => {
    render(<I18nProvider><FilterProvider><TimelinePanel /></FilterProvider></I18nProvider>)
  }
  const dots = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[data-timeline-event]'))
  const bar = (): HTMLElement | null => screen.queryByTestId('timeline-detail-panel')
  const body = (): HTMLElement | null => screen.queryByTestId('timeline-detail-body')
  const ready = async (): Promise<void> => { mount(); await waitFor(() => expect(dots()).toHaveLength(3)) }

  beforeEach(() => {
    b = installTimelineBridge()
    b.queryPage.mockResolvedValue(page([
      makeEvent('e1', T0 - 2000), makeEvent('e2', T0 - 1000), makeEvent('e3', T0)
    ]))
  })

  it('a single click selects and shows the bar, and leaves the body closed', async () => {
    await ready()
    fireEvent.click(dots()[0], { detail: 1 })
    await waitFor(() => expect(bar()).not.toBeNull())
    expect(body()).toBeNull()
    expect(screen.getByTestId('detail-toggle-body').getAttribute('aria-expanded')).toBe('false')
  })

  it('a double-click opens the body and keeps the selection (the second click does not toggle it off)', async () => {
    await ready()
    const dot = dots()[0]
    fireEvent.click(dot, { detail: 1 })
    await waitFor(() => expect(bar()).not.toBeNull())
    // Read between the clicks: a second click that ignored its count would
    // clear the selection here, and the double-click would then paper over it.
    fireEvent.click(dot, { detail: 2 })
    expect(bar()).not.toBeNull()
    fireEvent.doubleClick(dot)
    await waitFor(() => expect(body()).not.toBeNull())
    expect(bar()).not.toBeNull()
  })

  it('a double-click on the already selected dot ends selected with the body open', async () => {
    await ready()
    const dot = dots()[0]
    fireEvent.click(dot, { detail: 1 })
    await waitFor(() => expect(bar()).not.toBeNull())
    fireEvent.click(dot, { detail: 1 })
    expect(bar()).toBeNull()
    fireEvent.click(dot, { detail: 2 })
    expect(bar()).not.toBeNull()
    fireEvent.doubleClick(dot)
    await waitFor(() => expect(body()).not.toBeNull())
  })

  it('a double-click opens the event the FIRST click landed on, even if the layout moved under the pointer', async () => {
    await ready()
    const [first, second] = dots()
    fireEvent.click(first, { detail: 1 })
    await waitFor(() => expect(bar()).not.toBeNull())
    // The second click and the double-click are delivered to a neighbour.
    fireEvent.click(second, { detail: 2 })
    fireEvent.doubleClick(second)
    await waitFor(() => expect(body()).not.toBeNull())
    expect(screen.getByTestId('timeline-bar-title').textContent).toContain('cmd e1')
  })

  it('a plain click on another dot still selects that dot', async () => {
    await ready()
    const [first, second] = dots()
    fireEvent.click(first, { detail: 1 })
    await waitFor(() => expect(bar()).not.toBeNull())
    fireEvent.click(second, { detail: 1 })
    await waitFor(() => expect(screen.getByTestId('timeline-bar-title').textContent).toContain('cmd e2'))
  })

  it('only a deliberate single click on the selected dot clears it; the keyboard click and a second click do not', async () => {
    await ready()
    const dot = dots()[0]
    fireEvent.click(dot, { detail: 1 })
    await waitFor(() => expect(bar()).not.toBeNull())
    fireEvent.click(dot, { detail: 0 })
    expect(bar()).not.toBeNull()
    fireEvent.click(dot, { detail: 2 })
    expect(bar()).not.toBeNull()
    fireEvent.click(dot, { detail: 1 })
    await waitFor(() => expect(bar()).toBeNull())
  })

  it('Enter on a focused dot opens the body, and Enter again closes it', async () => {
    await ready()
    const dot = dots()[1]
    fireEvent.keyDown(dot, { key: 'Enter' })
    await waitFor(() => expect(body()).not.toBeNull())
    fireEvent.keyDown(dot, { key: 'Enter' })
    await waitFor(() => expect(body()).toBeNull())
    expect(bar()).not.toBeNull()
  })

  it('the bar steps the selection without opening the body, and its Details button opens it', async () => {
    await ready()
    fireEvent.click(dots()[0], { detail: 1 })
    await waitFor(() => expect(bar()).not.toBeNull())
    const before = bar()!.textContent
    fireEvent.click(screen.getByTestId('detail-step-next'))
    await waitFor(() => expect(bar()!.textContent).not.toBe(before))
    expect(body()).toBeNull()
    fireEvent.click(screen.getByTestId('detail-toggle-body'))
    await waitFor(() => expect(body()).not.toBeNull())
  })

  it('Escape peels help, then focus mode, then the body, then the selection', async () => {
    await ready()
    fireEvent.doubleClick(dots()[0])
    await waitFor(() => expect(body()).not.toBeNull())
    fireEvent.keyDown(window, { key: '?' })
    await screen.findByRole('dialog')
    fireEvent.keyDown(window, { key: 'f' })
    await screen.findByTestId('timeline-focus-badge')

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByTestId('timeline-focus-badge')).not.toBeNull()
    expect(body()).not.toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('timeline-focus-badge')).toBeNull())
    expect(body()).not.toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(body()).toBeNull())
    expect(bar()).not.toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(bar()).toBeNull())
  })

  it('Enter on a bar button acts on that button and does not also toggle the body', async () => {
    await ready()
    fireEvent.click(dots()[0], { detail: 1 })
    await waitFor(() => expect(bar()).not.toBeNull())
    fireEvent.keyDown(screen.getByTestId('detail-step-next'), { key: 'Enter' })
    expect(body()).toBeNull()
  })

  describe('the Reader', () => {
    const withRef = (id: string, ts: number) => makeEvent(id, ts, 'shell', {
      data: { subtype: 'command_end', command: `cmd ${id}`, stdout_ref: { sha256: 'a', size: 9, file: 'f', encoding: 'text' } }
    })
    let list: ReturnType<typeof vi.fn>
    beforeEach(() => {
      list = vi.fn(async ({ eventId }: { eventId: string }) => ({
        ok: true,
        value: [{ field: 'stdout', status: 'available', ref: { projectId: 'eng', eventId, field: 'stdout', version: 'v' }, bytes: 4, format: 'utf8', capture: 'unknown' }]
      }))
      b.queryPage.mockResolvedValue(page([withRef('e1', T0 - 2000), withRef('e2', T0 - 1000), makeEvent('e3', T0)]))
      ;(window as unknown as { redlog: { content: unknown } }).redlog.content = {
        list,
        read: vi.fn(async () => ({ ok: true, value: { offset: 0, end: 4, total: 4, text: 'body', format: 'utf8', hasMore: false, nextCursor: null } }))
      }
    })
    const dialog = (): HTMLElement | null => screen.queryByRole('dialog', { name: /./ })

    it('opens from the bar for a command with saved output, once, in the body', async () => {
      await ready()
      fireEvent.click(dots()[0], { detail: 1 })
      await waitFor(() => expect(bar()).not.toBeNull())
      fireEvent.click(screen.getByTestId('detail-open-reader'))
      await waitFor(() => expect(body()).not.toBeNull())
      await waitFor(() => expect(screen.getAllByRole('dialog', { name: /./ })).toHaveLength(1))
    })

    it('has no Reader button for an event with nothing saved', async () => {
      await ready()
      fireEvent.click(dots()[2], { detail: 1 })
      await waitFor(() => expect(bar()).not.toBeNull())
      expect(screen.queryByTestId('detail-open-reader')).toBeNull()
    })

    it('always ends expanded: from the inline Reader, and again after collapsing it', async () => {
      await ready()
      fireEvent.doubleClick(dots()[0])
      await waitFor(() => expect(body()).not.toBeNull())
      fireEvent.click(await screen.findByText('Saved content'))
      await waitFor(() => expect(list).toHaveBeenCalled())
      expect(dialog()).toBeNull()
      fireEvent.click(screen.getByTestId('detail-open-reader'))
      await waitFor(() => expect(dialog()).not.toBeNull())
      fireEvent.click(screen.getByText('Close expanded reader'))
      await waitFor(() => expect(dialog()).toBeNull())
      fireEvent.click(screen.getByTestId('detail-open-reader'))
      await waitFor(() => expect(dialog()).not.toBeNull())
    })

    it('mounts no Reader for the next event when the selection changes with one open', async () => {
      await ready()
      fireEvent.doubleClick(dots()[1])
      await waitFor(() => expect(body()).not.toBeNull())
      fireEvent.click(await screen.findByText('Saved content'))
      await waitFor(() => expect(list).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'e2' })))
      fireEvent.click(screen.getByTestId('detail-step-prev'))
      await waitFor(() => expect(screen.getByTestId('timeline-bar-title').textContent).toContain('cmd e1'))
      await new Promise((r) => setTimeout(r, 30))
      expect(list.mock.calls.some(([req]) => (req as { eventId: string }).eventId === 'e1')).toBe(false)
    })
  })

  it('closing the body with its X keeps the selection and the bar', async () => {
    await ready()
    fireEvent.doubleClick(dots()[0])
    await waitFor(() => expect(body()).not.toBeNull())
    fireEvent.click(screen.getByTestId('timeline-detail-close'))
    await waitFor(() => expect(body()).toBeNull())
    expect(bar()).not.toBeNull()
  })
})

describe('click contract on the card rail', () => {
  const T0 = 1_700_000_000_000
  const cards = (): HTMLElement[] => screen.queryAllByTestId('rail-card')
  const bar = (): HTMLElement | null => screen.queryByTestId('timeline-detail-panel')
  const body = (): HTMLElement | null => screen.queryByTestId('timeline-detail-body')
  beforeEach(() => {
    const b = installTimelineBridge({ timelineMode: 'standard' })
    b.queryPage.mockResolvedValue(page([makeEvent('e1', T0 - 2000), makeEvent('e2', T0 - 1000), makeEvent('e3', T0)]))
    render(<I18nProvider><FilterProvider><TimelinePanel /></FilterProvider></I18nProvider>)
  })
  const ready = async (): Promise<void> => { await waitFor(() => expect(cards()).toHaveLength(3)) }

  it('a click selects without the body; a double-click opens the card the first click landed on', async () => {
    await ready()
    fireEvent.click(cards()[0], { detail: 1 })
    await waitFor(() => expect(bar()).not.toBeNull())
    expect(body()).toBeNull()
    fireEvent.click(cards()[1], { detail: 2 })
    fireEvent.doubleClick(cards()[1])
    await waitFor(() => expect(body()).not.toBeNull())
    expect(screen.getByTestId('timeline-bar-title').textContent).toContain('cmd e1')
  })

  it('Enter on a card opens the body, and Enter again closes it', async () => {
    await ready()
    fireEvent.keyDown(cards()[1], { key: 'Enter' })
    await waitFor(() => expect(body()).not.toBeNull())
    fireEvent.keyDown(cards()[1], { key: 'Enter' })
    await waitFor(() => expect(body()).toBeNull())
    expect(bar()).not.toBeNull()
  })
})
