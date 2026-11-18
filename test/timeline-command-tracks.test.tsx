// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import en from '../src/renderer/src/i18n/en.json'
import { installTimelineBridge, makeEvent, page, type TimelineBridge } from './helpers/timeline-bridge'

// Spec 078 S1: in the standard mode, one row per terminal under the event
// row, holding the label and each command's line. S1 is deliberately
// transitional: every command is still a dot on the event row as well, and
// nothing new can be clicked.

const T0 = 1_700_000_000_000
const S = 1000
const LANE_H = 44
const AXIS_H = 48

type Extra = Record<string, unknown>
const cmd = (id: string, ts: number, subtype: 'command_start' | 'command_end', terminalId: string, cid: string, command: string, data: Extra = {}) =>
  makeEvent(id, ts, 'shell', { data: { subtype, terminalId, command_id: cid, command, shell: 'zsh', pid: 4821, ...(subtype === 'command_end' ? { exit_code: 0 } : {}), ...data } })

function twoTerminals() {
  const a = { shell: 'zsh', pid: 4821 }
  const b = { shell: 'bash', pid: 977 }
  return [
    cmd('a1s', T0, 'command_start', 'ta', 'c1', 'nmap -sV 10.0.0.5', a),
    cmd('a1e', T0 + 42 * S, 'command_end', 'ta', 'c1', 'nmap -sV 10.0.0.5', a),
    cmd('a2s', T0 + 60 * S, 'command_start', 'ta', 'c2', 'cat config.php', a),
    cmd('a2e', T0 + 65 * S, 'command_end', 'ta', 'c2', 'cat config.php', { ...a, exit_code: 1 }),
    cmd('a3s', T0 + 120 * S, 'command_start', 'ta', 'c3', 'nc -lvnp 4444', a),
    cmd('a4s', T0 + 180 * S, 'command_start', 'ta', 'c4', 'id', a),
    cmd('a4e', T0 + 200 * S, 'command_end', 'ta', 'c4', 'id', a),
    cmd('b1s', T0 + 10 * S, 'command_start', 'tb', 'd1', 'whoami', b),
    cmd('b1e', T0 + 30 * S, 'command_end', 'tb', 'd1', 'whoami', b),
    cmd('b2s', T0 + 240 * S, 'command_start', 'tb', 'd2', 'tail -f /var/log/x', b)
  ]
}

function mount(): void {
  render(<I18nProvider><FilterProvider><TimelinePanel /></FilterProvider></I18nProvider>)
}

const tracks = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-testid="timeline-command-track"]')]
const lineOf = (key: string): HTMLElement | null =>
  [...document.querySelectorAll<HTMLElement>('[data-testid="timeline-interval-line"]')].find((l) => l.dataset.intervalId?.includes(`"${key}"]`)) ?? null
const px = (v: string): number => parseFloat(v)

afterEach(() => cleanup())

describe('standard mode: one row per terminal (Spec 078 S1)', () => {
  let b: TimelineBridge
  beforeEach(() => {
    b = installTimelineBridge({ timelineMode: 'standard' })
    try { localStorage.clear() } catch { /* ignore */ }
  })

  it('with no command that has a pair key, the page is what it was: one row, no terminal rows (FR-016)', async () => {
    b.queryPage.mockResolvedValue(page([makeEvent('e1', T0 - 1000), makeEvent('e2', T0)]))
    mount()
    await waitFor(() => expect(document.querySelectorAll('[data-timeline-event]').length).toBe(2))
    expect(screen.queryByTestId('timeline-command-tracks')).toBeNull()
    expect(tracks()).toHaveLength(0)
    const track = screen.getByTestId('timeline-standard-track')
    expect(track.style.height).toBe(`${LANE_H}px`)
    expect(screen.getByTestId('timeline-lane-scroll').style.maxHeight).toBe(`${LANE_H + AXIS_H}px`)
    // One row background, as before.
    expect(track.querySelectorAll(':scope > div.w-full.border-b').length).toBe(1)
  })

  it('two terminals: two terminal rows under the event row, labelled `{shell} {pid}`, newest activity first', async () => {
    b.queryPage.mockResolvedValue(page(twoTerminals()))
    mount()
    await waitFor(() => expect(tracks()).toHaveLength(2))
    // tb's last activity (its open tail -f, +240 s) is later than ta's (+200 s).
    expect(tracks().map((t) => t.dataset.trackKey)).toEqual(['terminal:tb', 'terminal:ta'])
    expect(tracks().map((t) => t.querySelector('[data-testid="timeline-track-label"]')?.textContent)).toEqual(['bash 977', 'zsh 4821'])
    expect(tracks().map((t) => px(t.style.top))).toEqual([LANE_H, 2 * LANE_H])
    expect(screen.getByTestId('timeline-standard-track').style.height).toBe(`${3 * LANE_H}px`)
    expect(screen.getByTestId('timeline-lane-scroll').style.maxHeight).toBe(`${3 * LANE_H + AXIS_H}px`)
  })

  it('is drawn but not interactive, and every drawn row is still a dot (the S1 transitional state)', async () => {
    b.queryPage.mockResolvedValue(page(twoTerminals()))
    mount()
    await waitFor(() => expect(tracks()).toHaveLength(2))
    const layer = screen.getByTestId('timeline-command-tracks')
    expect(layer.getAttribute('aria-hidden')).toBe('true')
    expect(layer.className).toContain('pointer-events-none')
    expect(layer.querySelector('button, [tabindex], [data-timeline-event]')).toBeNull()
    // The 6 rows the fold draws (4 starts fold into their ends) are 6 dots.
    expect(document.querySelectorAll('[data-timeline-event]').length).toBe(6)
  })

  it('draws a line per command: solid when it ended, dashed to the next start when not, to the right edge when last (Q4)', async () => {
    b.queryPage.mockResolvedValue(page(twoTerminals()))
    mount()
    await waitFor(() => expect(tracks()).toHaveLength(2))
    expect(document.querySelectorAll('[data-testid="timeline-interval-line"]').length).toBe(6)
    for (const k of ['c1', 'c2', 'c4', 'd1']) expect(lineOf(k)?.dataset.line, k).toBe('solid')
    const open = lineOf('c3')!
    const next = lineOf('c4')!
    expect(open.dataset.line).toBe('dashed')
    expect(px(open.style.left) + px(open.style.width)).toBeCloseTo(px(next.style.left), 1)
    const last = lineOf('d2')!
    expect(last.dataset.line).toBe('dashed')
    // jsdom measures nothing, so the track is UNMEASURED_TRACK_W wide.
    expect(px(last.style.left) + px(last.style.width)).toBeCloseTo(2000, 1)
    // The line is on its own terminal's row.
    expect(tracks()[0].contains(last)).toBe(true)
    expect(tracks()[1].contains(open)).toBe(true)
  })

  it('an end whose start is not loaded gets a 16px stub, never a line from the loaded edge (FR-006)', async () => {
    b.queryPage.mockResolvedValue(page([
      cmd('x', T0, 'command_end', 'ta', 'c1', 'nmap'),
      makeEvent('m', T0 + 300 * S, 'browser')
    ], true, 'cursor'))
    mount()
    await waitFor(() => expect(tracks()).toHaveLength(1))
    const stub = lineOf('c1')!
    expect(stub.dataset.line).toBe('dashed')
    expect(px(stub.style.width)).toBe(16)
    expect(px(stub.style.left)).toBeGreaterThan(0)
  })

  it('an end stamped before its start draws no line, not a negative one (FR-008)', async () => {
    b.queryPage.mockResolvedValue(page([
      cmd('s', T0 + 50 * S, 'command_start', 'ta', 'c1', 'x'),
      cmd('e', T0 + 20 * S, 'command_end', 'ta', 'c1', 'x'),
      makeEvent('m', T0 + 300 * S, 'browser')
    ]))
    mount()
    await waitFor(() => expect(tracks()).toHaveLength(1))
    expect(lineOf('c1')).toBeNull()
  })

  // TRANSITIONAL (S1 only): the time range is still computed from the drawn
  // rows, which no longer include a folded start, so a long command's start
  // can fall left of the track. S1 clips the line at 0; S3 widens the range to
  // include interval starts (FR-065) and this case changes.
  it('S1 transitional: a line that starts left of the track is clipped at 0', async () => {
    b.queryPage.mockResolvedValue(page([
      cmd('s', T0 - 600 * S, 'command_start', 'ta', 'c1', 'nmap -p- 10.0.0.5'),
      cmd('e', T0 + 42 * S, 'command_end', 'ta', 'c1', 'nmap -p- 10.0.0.5'),
      makeEvent('m', T0 + 100 * S, 'browser')
    ]))
    mount()
    await waitFor(() => expect(tracks()).toHaveLength(1))
    expect(lineOf('c1')!.style.left).toBe('0px')
  })

  it('the built-in terminal keeps its session-band label', async () => {
    b.queryPage.mockResolvedValue(page([
      cmd('s', T0, 'command_start', 'ab12cd34-0000', 'c1', 'ls', { source: 'builtin-terminal' }),
      cmd('e', T0 + 5 * S, 'command_end', 'ab12cd34-0000', 'c1', 'ls', { source: 'builtin-terminal' })
    ]))
    mount()
    await waitFor(() => expect(tracks()).toHaveLength(1))
    const want = (en as Record<string, string>)['timeline.boundaries.termLabelFmt'].replace('{{id}}', 'ab12')
    expect(tracks()[0].querySelector('[data-testid="timeline-track-label"]')?.textContent).toBe(want)
  })

  it('holds the label at the visible left edge from the scroll position, not with sticky (E-6)', async () => {
    b.queryPage.mockResolvedValue(page(twoTerminals()))
    mount()
    await waitFor(() => expect(tracks()).toHaveLength(2))
    const label = (): HTMLElement => tracks()[0].querySelector('[data-testid="timeline-track-label"]') as HTMLElement
    expect(label().style.left).toBe('4px')
    expect(label().style.position).not.toBe('sticky')
    const scroller = screen.getByTestId('timeline-lane-scroll').firstElementChild as HTMLElement
    let left = 0
    Object.defineProperty(scroller, 'scrollLeft', { configurable: true, get: () => left, set: (v: number) => { left = v } })
    scroller.scrollLeft = 300
    fireEvent.scroll(scroller)
    await waitFor(() => expect(label().style.left).toBe('304px'))
  })
})

// Found in the harness, not in jsdom: the track scroller stretched to the
// capped height and clipped its own rows (overflow-y-hidden), so the lane
// scroller never overflowed and rows past the cap could not be reached by any
// means. With terminal rows the scroller takes its content's height, and the
// cap makes room for its horizontal scrollbar where the platform draws one
// (classic scrollbars), so three rows do not overflow by the bar's 10px and
// turn the wheel vertical. With no terminal rows nothing changes (FR-016).
describe('the scroller with terminal rows', () => {
  let b: TimelineBridge
  const proto = HTMLElement.prototype
  const saved = Object.getOwnPropertyDescriptor(proto, 'offsetHeight')!
  beforeEach(() => {
    b = installTimelineBridge({ timelineMode: 'standard' })
    try { localStorage.clear() } catch { /* ignore */ }
    // A 10px horizontal scrollbar: the track scroller's box is 10px taller
    // than its client area.
    Object.defineProperty(proto, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return this.classList.contains('cursor-grab') ? 10 : 0 } })
  })
  afterEach(() => { Object.defineProperty(proto, 'offsetHeight', saved) })

  it('takes its content height and leaves room for the horizontal scrollbar', async () => {
    b.queryPage.mockResolvedValue(page(twoTerminals()))
    mount()
    await waitFor(() => expect(tracks()).toHaveLength(2))
    const lanes = screen.getByTestId('timeline-lane-scroll')
    expect((lanes.firstElementChild as HTMLElement).classList.contains('self-start')).toBe(true)
    await waitFor(() => expect(lanes.style.maxHeight).toBe(`${3 * LANE_H + AXIS_H + 10}px`))
  })

  it('is unchanged with no terminal rows (FR-016)', async () => {
    b.queryPage.mockResolvedValue(page([makeEvent('e1', T0 - 1000), makeEvent('e2', T0)]))
    mount()
    await waitFor(() => expect(document.querySelectorAll('[data-timeline-event]').length).toBe(2))
    const lanes = screen.getByTestId('timeline-lane-scroll')
    expect((lanes.firstElementChild as HTMLElement).classList.contains('self-start')).toBe(false)
    expect(lanes.style.maxHeight).toBe(`${LANE_H + AXIS_H}px`)
  })
})

describe('more terminals than fit (Q1: three visible, the rest by vertical scroll)', () => {
  let b: TimelineBridge
  beforeEach(() => {
    b = installTimelineBridge({ timelineMode: 'standard' })
    try { localStorage.clear() } catch { /* ignore */ }
    const rows = []
    for (let i = 0; i < 5; i++) {
      rows.push(cmd(`s${i}`, T0 + i * 10 * S, 'command_start', `t${i}`, `c${i}`, `cmd ${i}`))
      rows.push(cmd(`e${i}`, T0 + i * 10 * S + 5 * S, 'command_end', `t${i}`, `c${i}`, `cmd ${i}`))
    }
    b.queryPage.mockResolvedValue(page(rows))
  })

  it('draws all five rows and caps the visible height at the event row and three terminal rows', async () => {
    mount()
    await waitFor(() => expect(tracks()).toHaveLength(5))
    expect(screen.getByTestId('timeline-standard-track').style.height).toBe(`${6 * LANE_H}px`)
    expect(screen.getByTestId('timeline-lane-scroll').style.maxHeight).toBe(`${4 * LANE_H + AXIS_H}px`)
  })

  // E-1: the wheel handler asked the measured wrapper whether the rows
  // overflow, but the wrapper never overflows: the scroll is on
  // timeline-lane-scroll. So the wheel always panned sideways, and rows past
  // the cap were out of the wheel's reach.
  it('the wheel scrolls the rows vertically while they overflow, and pans sideways when they do not (E-1)', async () => {
    // The wheel handler is bound when the track's width changes, and jsdom
    // measures none: report a width once, as the panel's observer would.
    ;(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      constructor(private cb: (entries: unknown[]) => void) {}
      observe(): void { this.cb([{ contentRect: { width: 1600, height: 400 } }]) }
      unobserve(): void {}
      disconnect(): void {}
    }
    mount()
    await waitFor(() => expect(tracks()).toHaveLength(5))
    const lanes = screen.getByTestId('timeline-lane-scroll')
    const scroller = lanes.firstElementChild as HTMLElement
    Object.defineProperty(lanes, 'clientHeight', { configurable: true, value: 4 * LANE_H + AXIS_H })
    Object.defineProperty(lanes, 'scrollHeight', { configurable: true, value: 6 * LANE_H + AXIS_H })
    // fireEvent returns false when the handler called preventDefault.
    expect(fireEvent.wheel(scroller, { deltaY: 40 }), 'left to the browser: a vertical scroll').toBe(true)
    expect(fireEvent.wheel(scroller, { deltaY: 40, shiftKey: true }), 'shift+wheel still pans').toBe(false)
    Object.defineProperty(lanes, 'scrollHeight', { configurable: true, value: 4 * LANE_H + AXIS_H })
    expect(fireEvent.wheel(scroller, { deltaY: 40 }), 'no overflow: the wheel pans').toBe(false)
  })
})
