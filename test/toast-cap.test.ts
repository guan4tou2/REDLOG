// UI/UX audit F4: a burst of later successes must not push an error — the
// toast that waits to be dismissed so it cannot go unseen — off the screen.
import { describe, expect, it } from 'vitest'
import { capToasts } from '../src/renderer/src/components/Toast'

const tt = (type: string, id: number): { type: string; id: number } => ({ type, id })

describe('capToasts', () => {
  it('keeps the error and drops the oldest non-errors', () => {
    const out = capToasts([tt('error', 1), tt('success', 2), tt('success', 3), tt('success', 4), tt('success', 5)])
    expect(out.map((x) => x.id)).toEqual([1, 4, 5])
  })

  it('still trims plain toasts to three, oldest first', () => {
    expect(capToasts([1, 2, 3, 4].map((i) => tt('info', i))).map((x) => x.id)).toEqual([2, 3, 4])
  })

  it('with only errors, keeps the newest three', () => {
    expect(capToasts([1, 2, 3, 4, 5].map((i) => tt('error', i))).map((x) => x.id)).toEqual([3, 4, 5])
  })
})
