// @vitest-environment jsdom
//
// #255: commands typed while no project was open are spooled without an
// engagement identity and set aside by replay. The Capture Health card now says
// how many, and when — and says nothing when there are none, so the line is
// never wallpaper.

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { CaptureHealthCard } from '../src/renderer/src/components/CaptureHealth'

const LINE = '[data-testid="capture-unattributed-spool"]'

function draw(unattributedSpool: { count: number; oldestAt: number; newestAt: number } | null): HTMLElement {
  const capture = {
    verdict: 'healthy',
    hasRecorded: true,
    sources: [],
    lastEventAt: null,
    checkedAt: 1,
    dbErrorTotal: 0,
    dbErrorFirstAt: null,
    unattributedSpool
  }
  return render(
    <I18nProvider>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <CaptureHealthCard capture={capture as any} onNavigate={() => {}} onRefresh={() => {}} />
    </I18nProvider>
  ).container
}

describe('the unattributed-spool line on the Capture Health card', () => {
  beforeEach(() => {
    ;(window as unknown as { redlog: unknown }).redlog = {
      config: { get: async () => ({}), save: async () => true },
      hooks: { install: async () => ({ success: true, message: '' }), uninstall: async () => ({ success: true, message: '' }) }
    }
  })
  afterEach(() => cleanup())

  it('is not there when nothing was set aside', () => {
    expect(draw(null).querySelector(LINE)).toBeNull()
  })

  it('says how many commands are missing and over what span', () => {
    const el = draw({ count: 8, oldestAt: Date.UTC(2026, 9, 12, 2, 0, 0), newestAt: Date.UTC(2026, 9, 12, 9, 30, 0) })
    const text = el.querySelector(LINE)?.textContent ?? ''
    expect(text).toMatch(/8 command\(s\) typed while no project was open/)
    expect(text).toMatch(/not in the record/)
    // A span, not one stamp: two different times appear.
    expect(text).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}.* – .*\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  })

  it('shows a single time when they all share one minute', () => {
    const t = Date.UTC(2026, 9, 12, 2, 0, 0)
    const text = draw({ count: 2, oldestAt: t, newestAt: t + 20_000 }).querySelector(LINE)?.textContent ?? ''
    expect(text).not.toContain(' – ')
  })

  it('tells the operator where the files are, for the one who wants to look', () => {
    const el = draw({ count: 1, oldestAt: 1_700_000_000_000, newestAt: 1_700_000_000_000 })
    expect(el.querySelector(`${LINE} [title]`)?.getAttribute('title')).toMatch(/~\/\.redlog\/pending/)
  })
})
