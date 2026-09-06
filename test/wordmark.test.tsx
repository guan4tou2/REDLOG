// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Wordmark } from '../src/renderer/src/components/Wordmark'

afterEach(cleanup)

describe('Wordmark (UIUX §4)', () => {
  it('reads as REDLOG and carries the brand colour, not danger red', () => {
    const { container } = render(<Wordmark />)
    const root = container.firstChild as HTMLElement
    expect(root.getAttribute('aria-label')).toBe('REDLOG')
    expect(root.textContent).toBe('REDLG') // REDL + ring(no text) + G
    expect(root.style.color.replace(/\s/g, '')).toBe('rgb(215,95,99)') // = #d75f63
  })

  it('renders the ring as a bordered circle by default', () => {
    const { container } = render(<Wordmark />)
    const ring = container.querySelector('[aria-hidden]') as HTMLElement
    expect(ring.style.borderRadius).toBe('50%')
    expect(ring.style.boxSizing).toBe('border-box')
    expect(ring.style.width).toBe('0.72em')
    expect(ring.style.border).toContain('0.115em solid') // ring stroke present
  })

  it('collapses the ring to a solid dot below 16px (dotOnly)', () => {
    const { container } = render(<Wordmark dotOnly />)
    const ring = container.querySelector('[aria-hidden]') as HTMLElement
    expect(ring.style.background.toLowerCase()).toBe('currentcolor')
    expect(ring.style.borderStyle).toBe('none')
  })
})
