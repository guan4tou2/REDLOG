// @vitest-environment jsdom
//
// The normal state is not louder than the abnormal one. Following live was the
// toolbar's only solid colour block while a failed read was small red text;
// live is now a dot and a word, and paused-behind keeps its warning tint.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FollowBadge } from '../src/renderer/src/components/timeline/TimelineClock'
import en from '../src/renderer/src/i18n/en.json'

const EN = en as Record<string, string>
const t = (k: string, v?: Record<string, string | number>): string =>
  (EN[k] ?? k).replace(/\{\{(\w+)\}\}/g, (_, n: string) => String(v?.[n] ?? ''))

afterEach(() => cleanup())

describe('the follow badge', () => {
  it('is a dot and a word while live, with no filled block', () => {
    const onPause = vi.fn()
    render(<FollowBadge latestTs={Date.now()} isLive onPause={onPause} onResume={vi.fn()} t={t} />)
    const badge = screen.getByTestId('timeline-follow-badge')
    expect(badge.textContent).toBe('Live')
    // No resting fill or ring (focus-visible / hover variants aside).
    expect(badge.className.split(/\s+/).filter((c) => c.startsWith('bg-') || c === 'ring-1')).toEqual([])
    expect(badge.querySelector('[aria-hidden="true"].rounded-full')).not.toBeNull()
    fireEvent.click(badge)
    expect(onPause).toHaveBeenCalled()
  })

  it('keeps the paused state tinted, and a click resumes', () => {
    const onResume = vi.fn()
    render(<FollowBadge latestTs={Date.now() - 120_000} isLive={false} onPause={vi.fn()} onResume={onResume} t={t} />)
    const badge = screen.getByTestId('timeline-follow-badge')
    expect(badge.className).toMatch(/bg-amber-500\/10/)
    fireEvent.click(badge)
    expect(onResume).toHaveBeenCalled()
  })
})
