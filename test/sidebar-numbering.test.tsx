// @vitest-environment jsdom
//
// The number printed beside a sidebar row must be the number its chord actually
// uses. Those were the same thing while every row was always rendered, and the
// component printed the rendered index — so today it prints 9, 10 and 11 beside
// three rows that have no chord, and a second "9" beside Settings' own. Once
// rows can be hidden the two diverge completely.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import Sidebar from '../src/renderer/src/components/Sidebar'
import { DEFAULT_ORDER, NUMBERED_SLOTS, shortcutNumberFor } from '../src/renderer/src/lib/sidebarOrder'

afterEach(cleanup)

function mount(): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    loot: { getCount: async () => 0 },
    scope: { getViolationCount: async () => 0 },
    events: { onNew: () => () => {} }
  }
  render(
    <I18nProvider>
      <Sidebar active="dashboard" onNavigate={vi.fn()} />
    </I18nProvider>
  )
}

const numberOn = (viewId: string): string | null => {
  const btn = document.querySelector(`[data-view-btn="${viewId}"]`)
  if (!btn) return null
  const spans = [...btn.querySelectorAll('span')].map((s) => s.textContent?.trim() ?? '')
  return spans.find((t) => /^\d+$/.test(t)) ?? null
}

describe('sidebar numbering', () => {
  it('prints the chord number for every numbered view', () => {
    mount()
    for (const view of DEFAULT_ORDER.slice(0, NUMBERED_SLOTS)) {
      expect(numberOn(view), `${view}`).toBe(String(shortcutNumberFor(view)))
    }
  })

  it('prints nothing beside a view that has no chord', () => {
    // Not "prints the next number up". A number that opens nothing is worse
    // than no number — it teaches a chord that does something else.
    mount()
    for (const view of DEFAULT_ORDER.slice(NUMBERED_SLOTS)) {
      expect(numberOn(view), `${view} should print no number`).toBeNull()
    }
  })

  it('leaves exactly one row wearing a 9, and it is Settings', () => {
    mount()
    const nines = [...document.querySelectorAll('[data-view-btn]')]
      .filter((b) => [...b.querySelectorAll('span')].some((s) => s.textContent?.trim() === '9'))
      .map((b) => b.getAttribute('data-view-btn'))
    expect(nines).toEqual(['settings'])
  })

  it('never advertises a chord in a row title that the row does not have', () => {
    mount()
    for (const view of DEFAULT_ORDER.slice(NUMBERED_SLOTS)) {
      const title = document.querySelector(`[data-view-btn="${view}"]`)?.getAttribute('title') ?? ''
      expect(title, `${view}: ${title}`).not.toMatch(/⌘\d|Ctrl\+\d/)
    }
  })
})
