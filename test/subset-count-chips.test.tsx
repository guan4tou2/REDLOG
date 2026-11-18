// @vitest-environment jsdom
//
// A count of what is loaded is not a total. The per-type chips in an opened
// target counted the first page of its evidence, and the per-trigger chips on
// Screenshots counted the first page of screenshots, and both read as totals
// while the line beside them ("1 / 3 events", "All ·2+") said there was more.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TargetView } from '../src/renderer/src/components/TargetView'
import { ScreenshotsView } from '../src/renderer/src/components/ScreenshotsView'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { installTimelineBridge, makeEvent, page, type TimelineBridge } from './helpers/timeline-bridge'

const T0 = 1_700_000_000_000

beforeEach(() => { window.localStorage.clear(); window.localStorage.setItem('redlog-locale', 'en') })
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear() })

describe('target evidence chips', () => {
  let b: TimelineBridge
  const cmd = (id: string, ts: number): ReturnType<typeof makeEvent> =>
    makeEvent(id, ts, 'shell', { targetId: 'a.test', data: { subtype: 'command_end', command: `cmd-${id}` } })
  beforeEach(() => {
    b = installTimelineBridge()
    const r = (window as unknown as { redlog: Record<string, Record<string, unknown>> }).redlog
    r.events.aggregateTargets = async () => [{ target: 'a.test', eventCount: 3, firstSeen: T0, lastSeen: T0 + 2 }]
  })
  const chips = (): string[] => [...document.querySelectorAll('span.rounded')]
    .map((el) => el.textContent ?? '').filter((s) => /: \d+\+?$/.test(s))

  it('marks the chips when the target has more events than are loaded', async () => {
    b.queryPage.mockImplementation(async () => page([cmd('e2', T0 + 2)], true, 'c1'))
    render(<I18nProvider><FilterProvider><TargetView /></FilterProvider></I18nProvider>)
    fireEvent.click(await screen.findByText('a.test'))
    await screen.findByText('1 / 3 events')
    expect(chips()).toHaveLength(1)
    expect(chips()[0], 'a count of one loaded page read as the total').toMatch(/: 1\+$/)
  })

  it('leaves the chips plain once every event is loaded', async () => {
    b.queryPage.mockImplementation(async () => page([cmd('e3', T0 + 2), cmd('e2', T0 + 1), cmd('e1', T0)]))
    render(<I18nProvider><FilterProvider><TargetView /></FilterProvider></I18nProvider>)
    fireEvent.click(await screen.findByText('a.test'))
    await screen.findByText('3 / 3 events')
    expect(chips()).toHaveLength(1)
    expect(chips()[0]).toMatch(/: 3$/)
  })
})

describe('screenshot trigger chips', () => {
  const shot = (n: number, trigger: string): Record<string, unknown> => ({
    id: `s${n}`, timestamp: 1_000_000 + n, agentType: 'screenshot', targetId: null,
    data: { filename: `s${n}.png`, filePath: `/x/s${n}.png`, trigger, sha256: `sha-${n}`.padEnd(64, '0') }
  })
  const install = (items: unknown[], hasMore: boolean): void => {
    ;(window as unknown as { redlog: unknown }).redlog = {
      events: {
        queryScreenshotPage: vi.fn(async () => ({ items, hasMore, nextCursor: hasMore ? 'more' : null })),
        onNewBatch: () => () => {}
      },
      screenshot: { deleteFile: vi.fn(async () => ({ ok: true })) },
      artifacts: { reveal: vi.fn(async () => true) }
    }
  }
  const chipCounts = (): string[] => [...screen.getByTestId('screenshots-toolbar').querySelectorAll('button[aria-pressed]')]
    .map((el) => el.textContent ?? '').filter((s) => s.includes('·'))

  it('marks every chip when only the first page is loaded', async () => {
    install([shot(3, 'manual'), shot(2, 'manual'), shot(1, 'command')], true)
    render(<I18nProvider><ScreenshotsView onNavigate={() => {}} /></I18nProvider>)
    await screen.findByTestId('screenshot-list')
    await waitFor(() => expect(chipCounts()).toHaveLength(3))
    const [all, ...triggers] = chipCounts()
    expect(all).toMatch(/·3\+$/)
    for (const c of triggers) expect(c, 'a trigger count of the first page read as the total').toMatch(/·\d+\+$/)
  })

  // The chips are counted from the first unfiltered page, so whether they
  // are complete is that page's answer, not the selected trigger's.
  it('keeps the marks while a trigger whose screenshots all fit is selected', async () => {
    install([], false)
    const all = [shot(3, 'manual'), shot(2, 'manual'), shot(1, 'command')]
    const r = (window as unknown as { redlog: { events: { queryScreenshotPage: ReturnType<typeof vi.fn> } } }).redlog
    r.events.queryScreenshotPage.mockImplementation(async (req: { trigger: string | null }) => req.trigger === null
      ? { items: all, hasMore: true, nextCursor: 'more' }
      : { items: all.filter((x) => (x.data as { trigger: string }).trigger === req.trigger), hasMore: false, nextCursor: null })
    render(<I18nProvider><ScreenshotsView onNavigate={() => {}} /></I18nProvider>)
    await waitFor(() => expect(chipCounts()).toHaveLength(3))
    const commandChip = [...screen.getByTestId('screenshots-toolbar').querySelectorAll('button[aria-pressed]')]
      .find((el) => (el.textContent ?? '').startsWith('after command')) as HTMLElement
    fireEvent.click(commandChip)
    await waitFor(() => expect(r.events.queryScreenshotPage).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'command' })))
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Screenshot at/ })).toHaveLength(1))
    for (const c of chipCounts()) expect(c).toMatch(/·\d+\+$/)
  })

  it('leaves the chips plain when the first page is everything', async () => {
    install([shot(3, 'manual'), shot(2, 'manual'), shot(1, 'command')], false)
    render(<I18nProvider><ScreenshotsView onNavigate={() => {}} /></I18nProvider>)
    await screen.findByTestId('screenshot-list')
    await waitFor(() => expect(chipCounts()).toHaveLength(3))
    for (const c of chipCounts()) expect(c).toMatch(/·\d+$/)
  })
})
