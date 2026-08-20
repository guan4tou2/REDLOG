// @vitest-environment jsdom
//
// The keyboard contract every list view shares (UIUX-STANDARD §9). Findings,
// Loot, Targets, Scope and Search were the same interaction under six
// component names, each having arrived at a different answer — mostly
// "nothing". This pins the answer.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { useListKeyboard } from '../src/renderer/src/lib/useListKeyboard'

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
