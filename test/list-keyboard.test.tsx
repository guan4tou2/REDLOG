// @vitest-environment jsdom
//
// The keyboard contract every list view shares (UIUX-STANDARD §9). Findings,
// Loot, Targets, Scope and Search were the same interaction under six
// component names, each having arrived at a different answer — mostly
// "nothing". This pins the answer.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { useListKeyboard } from '../src/renderer/src/lib/useListKeyboard'
import fs from 'fs'
import path from 'path'

afterEach(cleanup)

function Harness({ count, ...cbs }: {
  count: number
  onActivate?: (i: number) => void
  onJumpToTimeline?: (i: number) => void
  onEscape?: () => void
}): JSX.Element {
  const list = useListKeyboard({ count, ...cbs })
  return (
    <div {...list.containerProps} data-testid="list">
      {Array.from({ length: count }, (_, i) => {
        const p = list.itemProps(i)
        return <button key={i} {...p} ref={(el) => p.ref(el)} data-testid={`row-${i}`}>row {i}</button>
      })}
      <span data-testid="index">{list.index}</span>
    </div>
  )
}

const index = (): string => screen.getByTestId('index').textContent ?? ''
const key = (k: string, mods: Record<string, boolean> = {}): void => {
  fireEvent.keyDown(screen.getByTestId('list'), { key: k, ...mods })
}

describe('list keyboard', () => {
  it('walks with the arrows and clamps at both ends', () => {
    render(<Harness count={3} />)
    key('ArrowDown'); expect(index()).toBe('0')
    key('ArrowDown'); key('ArrowDown'); expect(index()).toBe('2')
    key('ArrowDown'); expect(index()).toBe('2')
    key('ArrowUp'); key('ArrowUp'); key('ArrowUp'); expect(index()).toBe('0')
  })

  it('ArrowUp from nothing selected starts at the bottom', () => {
    // Which is what you want in a list sorted newest-last.
    render(<Harness count={3} />)
    key('ArrowUp'); expect(index()).toBe('2')
  })

  it('Home and End jump to the ends', () => {
    render(<Harness count={5} />)
    key('End'); expect(index()).toBe('4')
    key('Home'); expect(index()).toBe('0')
  })

  it('separates Enter from ⌘Enter', () => {
    const onActivate = vi.fn()
    const onJumpToTimeline = vi.fn()
    render(<Harness count={2} onActivate={onActivate} onJumpToTimeline={onJumpToTimeline} />)
    key('ArrowDown')
    key('Enter')
    expect(onActivate).toHaveBeenCalledWith(0)
    expect(onJumpToTimeline).not.toHaveBeenCalled()

    key('Enter', { metaKey: true })
    expect(onJumpToTimeline).toHaveBeenCalledWith(0)
    expect(onActivate).toHaveBeenCalledOnce()
  })

  it('Escape backs out one level at a time', () => {
    // §5.7. The first Escape drops the selection; only the second one is the
    // panel's to handle, so a list cannot swallow the key forever.
    const onEscape = vi.fn()
    render(<Harness count={3} onEscape={onEscape} />)
    key('ArrowDown')
    key('Escape')
    expect(index()).toBe('-1')
    expect(onEscape).not.toHaveBeenCalled()
    key('Escape')
    expect(onEscape).toHaveBeenCalledOnce()
  })

  it('is one Tab stop, not one per row', () => {
    // A hundred loot rows should not be a hundred stops on the way to the
    // next control.
    render(<Harness count={4} />)
    key('ArrowDown')
    const tabbable = [0, 1, 2, 3]
      .map((i) => screen.getByTestId(`row-${i}`).getAttribute('tabindex'))
    expect(tabbable).toEqual(['0', '-1', '-1', '-1'])
  })

  it('marks the selected row for a screen reader', () => {
    render(<Harness count={3} />)
    key('ArrowDown')
    expect(screen.getByTestId('row-0').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('row-1').getAttribute('aria-selected')).toBe('false')
  })

  it('does not leave the selection past the end when the list shrinks', () => {
    // A filter narrowing under the cursor used to leave `index` pointing at a
    // row that no longer exists, and Enter then did nothing at all.
    const { rerender } = render(<Harness count={5} />)
    key('End'); expect(index()).toBe('4')
    rerender(<Harness count={2} />)
    expect(index()).toBe('1')
  })

  it('ignores keys on an empty list', () => {
    const onActivate = vi.fn()
    render(<Harness count={0} onActivate={onActivate} />)
    key('ArrowDown'); key('Enter')
    expect(index()).toBe('-1')
    expect(onActivate).not.toHaveBeenCalled()
  })
})

// The checklist says "全部清單頁一致" — every list page, the same keys. That is
// a property of the tree, not of the hook, and it is exactly the kind of thing
// that ends up 80% done: Findings, Loot and Search got it, while Targets and
// Scope violations — the two lists an operator reaches for under time pressure
// — did not, and nothing said so.
//
// The list was hand-written, which is the same failure one level up: a sixth
// list view (HttpHistoryPanel) arrived from another branch and the test that
// exists to catch exactly this said nothing, because the file was not named
// in it. So the views are now discovered — anything the sidebar routes to is
// checked, and a new one is opted *out* explicitly rather than in by
// omission.
describe('every list view uses the shared contract', () => {
  const COMPONENTS = path.join(__dirname, '../src/renderer/src/components')

  /** Views the sidebar can reach, from the single source that orders it. */
  const sidebarViews = fs
    .readFileSync(path.join(__dirname, '../src/renderer/src/lib/sidebarOrder.ts'), 'utf-8')
    .match(/DEFAULT_ORDER[^=]*=\s*\[([^\]]*)\]/s)?.[1]
    .match(/'(\w+)'/g)
    ?.map((q) => q.slice(1, -1)) ?? []

  // Surfaces with no row list to move through. Each is a deliberate opt-out,
  // not an oversight — which is the difference this rewrite is for.
  const NOT_LISTS: Record<string, string> = {
    dashboard: 'cards, not rows',
    timeline: 'has its own two-axis keyboard model (§7)',
    transcript: 'a scrolling document',
    terminal: 'xterm owns the keyboard',
    screenshots: 'a grid, navigated by arrow keys in its own component'
  }

  const FILE_FOR: Record<string, string> = {
    marks: 'FindingsView.tsx',
    loot: 'LootPanel.tsx',
    search: 'SearchPanel.tsx',
    targets: 'TargetView.tsx',
    scope: 'ScopeStatus.tsx',
    http_history: 'HttpHistoryPanel.tsx'
  }

  const LIST_VIEWS = sidebarViews
    .filter((v) => !(v in NOT_LISTS))
    .map((v) => FILE_FOR[v] ?? `__unmapped:${v}`)

  it('maps every sidebar view to a file or an explicit opt-out', () => {
    // A discovered list needs a floor. The first version of this parse looked
    // for the wrong constant name, found nothing, and `it.each([])` generated
    // zero tests — reported as a pass. That is the same silent-success this
    // rewrite exists to remove, one level up again.
    expect(sidebarViews.length, 'parsed no sidebar views — check the constant name')
      .toBeGreaterThanOrEqual(9)
    expect(LIST_VIEWS.length, 'no list views to check').toBeGreaterThanOrEqual(5)
    // A view that is neither mapped nor opted out fails here rather than
    // silently dropping out of the contract below.
    expect(LIST_VIEWS.filter((f) => f.startsWith('__unmapped:'))).toEqual([])
  })

  it.each(LIST_VIEWS)('%s wires useListKeyboard', (file) => {
    const src = fs.readFileSync(path.join(COMPONENTS, file), 'utf-8')
    expect(src, 'imports the hook').toMatch(/useListKeyboard/)
    // Spreading both halves is what actually makes the keys work; importing
    // the hook and forgetting the container is a silent no-op.
    expect(src, 'spreads containerProps onto the scroll container').toMatch(/\{\.\.\.\w*\.?containerProps\}/)
    expect(src, 'spreads itemProps onto each row').toMatch(/itemProps\(/)
  })
})
