// @vitest-environment jsdom
//
// A fixed page header above a scrolling body: the body's scrollbar took its
// width out of the body only, so the header (and its tab underline) ran one
// scrollbar further right than the cards below it. The body now keeps its
// gutter always (SCROLL_GUTTER), and the header ends in an empty box that
// keeps the same one (HEADER_GUTTER). jsdom draws no scrollbars, so what is
// checked here is that both halves are in place on every such page; the
// widths themselves are e2e/layout-leftovers.spec.ts.

import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { HEADER_GUTTER, SCROLL_GUTTER } from '../src/renderer/src/lib/pageLayout'
import { I18nProvider } from '../src/renderer/src/i18n'
import { EvidenceHeader } from '../src/renderer/src/components/EvidenceHeader'
import { TargetsScopeHeader } from '../src/renderer/src/components/TargetsScopeHeader'

vi.mock('../src/renderer/src/lib/useAppCounts', () => ({ useAppCounts: () => ({ scopeObservations: 0 }) }))

afterEach(() => cleanup())

const bridge = (): void => {
  ;(window as unknown as { redlog: unknown }).redlog = {
    config: { get: async () => ({ scope: { targets: [], excludeTargets: [] } }) },
    events: { aggregateTargets: async () => [], count: async () => 0, onNewBatch: () => () => {} },
    bookmarks: { list: async () => [] }
  }
}

/** The header's last child keeps the gutter, after a content box that takes the rest. */
function expectGutterLast(header: HTMLElement): void {
  const last = header.lastElementChild as HTMLElement
  expect(last.hasAttribute('data-scroll-gutter')).toBe(true)
  expect(last.className).toBe(HEADER_GUTTER)
  expect(last.textContent).toBe('')
  expect(header.className.split(' ')).toContain('flex')
  expect(header.className.split(' ')).toContain('px-pad')
}

describe('a fixed header keeps the scrolling body\'s right edge', () => {
  it('both halves reserve a stable gutter', () => {
    expect(SCROLL_GUTTER).toContain('[scrollbar-gutter:stable]')
    expect(HEADER_GUTTER).toContain('[scrollbar-gutter:stable]')
    // A gutter is only kept by a box that can scroll or clip.
    expect(HEADER_GUTTER).toContain('overflow-y-hidden')
  })

  it('Targets & Scope', () => {
    bridge()
    render(<I18nProvider><TargetsScopeHeader page="targets" onNavigate={vi.fn()} onOpenSettings={vi.fn()} /></I18nProvider>)
    expectGutterLast(screen.getByTestId('targets-scope-header'))
  })

  it('Evidence', () => {
    bridge()
    render(<I18nProvider><EvidenceHeader page="screenshots" onNavigate={vi.fn()} /></I18nProvider>)
    expectGutterLast(screen.getByTestId('evidence-header'))
  })

  // The bodies under those headers, and Activity's own header + results.
  const COMPONENTS = path.join(__dirname, '..', 'src', 'renderer', 'src', 'components')
  it.each([
    ['TargetView.tsx', 'p-pad h-full overflow-auto ${SCROLL_GUTTER}'],
    ['ScopeStatus.tsx', 'p-pad overflow-auto h-full ${SCROLL_GUTTER}'],
    ['ScreenshotsView.tsx', 'p-pad overflow-auto h-full ${SCROLL_GUTTER}'],
    ['LootPanel.tsx', 'p-pad space-y-4 overflow-auto h-full ${SCROLL_GUTTER}'],
    ['BookmarksView.tsx', 'flex-1 min-h-0 overflow-auto ${SCROLL_GUTTER}'],
    ['SearchPanel.tsx', 'flex-1 overflow-auto min-h-0 px-pad ${SCROLL_GUTTER}'],
    ['RecordingWorkspace.tsx', 'data-scroll-gutter className={HEADER_GUTTER}']
  ])('%s', (file, needle) => {
    expect(fs.readFileSync(path.join(COMPONENTS, file), 'utf8')).toContain(needle)
  })
})
