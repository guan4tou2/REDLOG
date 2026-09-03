// @vitest-environment jsdom
//
// The Inspector half of design turn 8b. The interesting claims are not about
// markup: that the editor is seeded from what the operator can SEE rather than
// from what was first written, that pressing commit on an unchanged draft puts
// nothing in the chain, and that Escape cancels an edit instead of closing the
// panel out from under it.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import fs from 'fs'
import path from 'path'
import { I18nProvider } from '../src/renderer/src/i18n'
import { MarkerDetail } from '../src/renderer/src/components/MarkerDetail'
import { foldMarker } from '../src/renderer/src/lib/markerFold'
import type { RedLogEvent } from '../src/core/db/events'

afterEach(cleanup)

let seq = 0
const ev = (data: Record<string, unknown>, o: Partial<RedLogEvent> = {}): RedLogEvent => {
  seq += 1
  return {
    id: `evt-${seq}`, timestamp: 1_700_000_000_000 + seq * 1000,
    engagementId: 'eng', sessionId: 'sess', operatorId: 'op-1',
    agentType: 'marker', hostname: 'host', sourceIP: null, targetId: null,
    data, createdAt: 1_700_000_000_000 + seq * 1000,
    monotonicNs: `${String(1_700_000_000_000).padStart(14, '0')}-${String(seq).padStart(20, '0')}`,
    hash: 'a'.repeat(64), ...o
  }
}

const marker = (d: Record<string, unknown> = {}): RedLogEvent =>
  ev({ title: 'original title', severity: 'info', notes: 'first pass', category: 'custom', ...d })
const amend = (markerId: string, changes: Record<string, unknown>): RedLogEvent =>
  ev({ subtype: 'amended', markerId, _causes: [markerId], ...changes })

function mount(event: RedLogEvent, amendments: RedLogEvent[] = [], over: Record<string, unknown> = {}): {
  onAmend: ReturnType<typeof vi.fn>
  onSelect: ReturnType<typeof vi.fn>
  onResolveOriginal: ReturnType<typeof vi.fn>
} {
  const onAmend = vi.fn(); const onSelect = vi.fn(); const onResolveOriginal = vi.fn()
  render(
    <I18nProvider>
      <MarkerDetail
        event={event}
        fold={amendments.length ? foldMarker(event, amendments) : undefined}
        linkedScreenshots={[]}
        tz="local"
        projectTz={null}
        operatorLabel={(id) => id}
        onAmend={onAmend}
        onSelect={onSelect}
        onResolveOriginal={onResolveOriginal}
        {...over}
      />
    </I18nProvider>
  )
  return { onAmend, onSelect, onResolveOriginal }
}

const edit = (): void => fireEvent.click(screen.getByTestId('marker-amend'))
const title = (): HTMLInputElement => screen.getByTestId('marker-amend-title') as HTMLInputElement
const notes = (): HTMLTextAreaElement => screen.getByTestId('marker-amend-notes') as HTMLTextAreaElement

describe('reading a marker', () => {
  it('shows what it says now, not what it said first', () => {
    mount(marker(), [amend('evt-1', { title: 'corrected title' })])
    expect(screen.getByText('corrected title')).toBeTruthy()
    expect(screen.queryByText('original title')).toBeNull()
  })

  it('never invents a URL row — a marker event has no url field', () => {
    mount(marker())
    expect(screen.queryByText(/url/i)).toBeNull()
  })

  // jsdom reports an English navigator locale, so I18nProvider renders `en`.
  it('says why each unchangeable field cannot change', () => {
    mount(marker({ atTimestamp: 1_699_999_000_000 }))
    const html = document.body.innerHTML
    expect(html).toContain('the chain hash covers it')
    expect(html).toContain('moving it moves the evidence')
  })

  it('omits the drop point when the marker was never dropped at one', () => {
    mount(marker())
    expect(document.body.innerHTML).not.toContain('moving it moves the evidence')
  })

  it('hides the amendment history until there is one (§22)', () => {
    mount(marker())
    expect(screen.queryByTestId('marker-history')).toBeNull()
    // But the verb is always available — 〈修訂〉 is an action, not a noun.
    expect(screen.getByTestId('marker-amend')).toBeTruthy()
  })

  it('lists one history row per amendment, including one that applies nothing', () => {
    const m = marker()
    mount(m, [amend(m.id, { title: 'second' }), amend(m.id, { severity: 'nonsense' })])
    const rows = screen.getAllByTestId('marker-history-row')
    expect(rows).toHaveLength(2)
    expect(rows[1].textContent).toContain('changes nothing that can be applied')
  })
})

describe('writing a correction', () => {
  it('seeds the editor from what is on screen, not from the first version', () => {
    const m = marker()
    mount(m, [amend(m.id, { title: 'corrected title' })])
    edit()
    expect(title().value).toBe('corrected title')
  })

  it('sends only the fields that actually changed', () => {
    const m = marker()
    const { onAmend } = mount(m)
    edit()
    fireEvent.change(title(), { target: { value: 'a better title' } })
    fireEvent.keyDown(title(), { key: 'Enter' })
    expect(onAmend).toHaveBeenCalledTimes(1)
    expect(onAmend.mock.calls[0][1]).toEqual({ title: 'a better title' })
  })

  it('commits from anywhere with ⌘↩, and a plain Enter in the notes does not', () => {
    const m = marker()
    const { onAmend } = mount(m)
    edit()
    fireEvent.change(notes(), { target: { value: 'more context' } })
    fireEvent.keyDown(notes(), { key: 'Enter' })
    expect(onAmend).not.toHaveBeenCalled()
    fireEvent.keyDown(notes(), { key: 'Enter', metaKey: true })
    expect(onAmend.mock.calls[0][1]).toEqual({ notes: 'more context' })
  })

  it('writes nothing when the draft is unchanged', () => {
    const { onAmend } = mount(marker())
    edit()
    fireEvent.keyDown(title(), { key: 'Enter' })
    expect(onAmend).not.toHaveBeenCalled()
    expect(screen.getByTestId('marker-amend')).toBeTruthy()   // back to read mode
  })

  it('writes nothing for a blank title', () => {
    const { onAmend } = mount(marker())
    edit()
    fireEvent.change(title(), { target: { value: '   ' } })
    fireEvent.keyDown(title(), { key: 'Enter' })
    expect(onAmend).not.toHaveBeenCalled()
  })

  it('cancels on Escape without letting the panel close underneath', () => {
    // The Timeline's window handler reads Escape as "close the Inspector" and
    // only exempts real text inputs, so an edit cancelled from a severity chip
    // would otherwise take the whole panel with it.
    const onWindowKey = vi.fn()
    window.addEventListener('keydown', onWindowKey)
    const { onAmend } = mount(marker())
    edit()
    fireEvent.change(title(), { target: { value: 'half-typed' } })
    fireEvent.keyDown(screen.getByTestId('marker-amend-severity-critical'), { key: 'Escape', bubbles: true })
    expect(onAmend).not.toHaveBeenCalled()
    expect(onWindowKey).not.toHaveBeenCalled()
    edit()
    expect(title().value).toBe('original title')   // the draft was discarded
    window.removeEventListener('keydown', onWindowKey)
  })

  it('changes severity through the chips', () => {
    const { onAmend } = mount(marker())
    edit()
    fireEvent.click(screen.getByTestId('marker-amend-severity-critical'))
    fireEvent.keyDown(title(), { key: 'Enter' })
    expect(onAmend.mock.calls[0][1]).toEqual({ severity: 'critical' })
  })
})

describe('an amendment selected on its own', () => {
  it('reads as the correction it is and offers the way back', () => {
    const { onResolveOriginal } = mount(amend('evt-original', { severity: 'critical' }))
    expect(screen.getByTestId('marker-amendment-view')).toBeTruthy()
    expect(screen.queryByTestId('marker-amend')).toBeNull()   // no editing an amendment
    fireEvent.click(screen.getByTestId('marker-amend-resolve-original'))
    expect(onResolveOriginal).toHaveBeenCalledWith('evt-original')
  })
})

describe('house rules', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer/src/components/MarkerDetail.tsx'), 'utf-8')

  it('never colours a number in danger red', () => {
    for (const m of src.matchAll(/className="([^"]*)"/g)) {
      if (!/tabular-nums/.test(m[1])) continue
      expect(m[1], `danger on a numeral: ${m[1]}`).not.toMatch(/redlog-danger|red-[45]00/)
    }
  })

  it('formats every time through lib/time', () => {
    expect(src).not.toMatch(/new Date\(|toLocale(Time|Date)/)
  })

  it('gives every truncating span something to hover', () => {
    for (const m of src.matchAll(/<span[^>]*className="[^"]*truncate[^"]*"[^>]*>/g)) {
      expect(m[0], `truncated with no title: ${m[0]}`).toContain('title=')
    }
  })

  it('has exactly one filled primary', () => {
    expect(src.match(/level="primary"/g) ?? []).toHaveLength(1)
  })
})
