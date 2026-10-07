// @vitest-environment jsdom
//
// A title-bar control threw during a passive effect and the whole app root
// went with it: a black window, shortcuts still firing, nothing on screen to
// say why. The title bar holds the evidence verbs — screenshot, attach file,
// marker — so that is a capture outage produced by one unrelated button.
//
// What has to hold: the barrier is per control, the survivors keep working,
// and the failure stays visible rather than quietly vanishing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { ControlBoundary } from '../src/renderer/src/components/ControlBoundary'

/** Throws where the real one did: in the effect, after a clean first render. */
function ThrowsInEffect({ message }: { message: string }): JSX.Element {
  useEffect(() => { throw new Error(message) }, [message])
  return <button>擷取瀏覽器</button>
}

function ThrowsOnRender(): JSX.Element {
  throw new Error('useCallback is not defined')
}

function Strip({ children }: { children: React.ReactNode }): JSX.Element {
  return <I18nProvider>{children}</I18nProvider>
}

beforeEach(() => {
  localStorage.setItem('redlog-locale', 'zh-TW')
  // React logs the caught error; the test is about what the operator sees.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

describe('one control failing', () => {
  it('leaves every other control on the strip working', () => {
    const onShot = vi.fn()
    render(
      <Strip>
        <ControlBoundary name="擷取瀏覽器"><ThrowsInEffect message="onExited is not a function" /></ControlBoundary>
        <button onClick={onShot}>截圖</button>
        <button>標記</button>
      </Strip>
    )
    // The thrower is gone...
    expect(screen.queryByText('擷取瀏覽器')).toBeNull()
    // ...and its neighbours are not, and still respond.
    fireEvent.click(screen.getByText('截圖'))
    expect(onShot).toHaveBeenCalledOnce()
    expect(screen.getByText('標記')).toBeTruthy()
  })

  it('catches a throw during render too, not only in an effect', () => {
    render(
      <Strip>
        <ControlBoundary name="匯出"><ThrowsOnRender /></ControlBoundary>
        <button>截圖</button>
      </Strip>
    )
    expect(screen.getByTestId('control-broken')).toBeTruthy()
    expect(screen.getByText('截圖')).toBeTruthy()
  })

  it('leaves a marker that names the control and carries the message', () => {
    // §II: a control that quietly disappears reads as one that was never
    // there, and the operator reaches for it later and finds nothing.
    render(
      <Strip>
        <ControlBoundary name="擷取瀏覽器"><ThrowsInEffect message="onExited is not a function" /></ControlBoundary>
      </Strip>
    )
    const broken = screen.getByTestId('control-broken')
    expect(broken.getAttribute('aria-label')).toContain('擷取瀏覽器')
    expect(broken.getAttribute('title')).toContain('onExited is not a function')
  })

  it('retries on click, and comes back when the cause is gone', () => {
    function Flaky(): JSX.Element {
      if (!fixed) throw new Error('not yet')
      return <button>擷取瀏覽器</button>
    }
    let fixed = false
    const { rerender } = render(
      <Strip><ControlBoundary name="擷取瀏覽器"><Flaky /></ControlBoundary></Strip>
    )
    expect(screen.getByTestId('control-broken')).toBeTruthy()

    fixed = true
    fireEvent.click(screen.getByTestId('control-broken'))
    rerender(<Strip><ControlBoundary name="擷取瀏覽器"><Flaky /></ControlBoundary></Strip>)
    expect(screen.getByText('擷取瀏覽器')).toBeTruthy()
    expect(screen.queryByTestId('control-broken')).toBeNull()
  })

  it('does not reflow the strip: the replacement is the same 28px box', () => {
    // A strip that re-lays-out on a crash makes the operator re-find every
    // button that still works.
    render(
      <Strip><ControlBoundary name="匯出"><ThrowsOnRender /></ControlBoundary></Strip>
    )
    const cls = screen.getByTestId('control-broken').className
    expect(cls).toMatch(/h-7/)
    expect(cls).toMatch(/w-7/)
  })

  it('adds no DOM of its own while the control is healthy', () => {
    // It sits between a flex container and its children in the title bar; a
    // wrapper element would collapse the row's gap and alignment.
    function Probe(): JSX.Element {
      const [n] = useState(1)
      return <button data-testid="probe">{n}</button>
    }
    const { container } = render(
      <Strip><div data-testid="row"><ControlBoundary name="匯出"><Probe /></ControlBoundary></div></Strip>
    )
    const row = container.querySelector('[data-testid="row"]')!
    expect(row.children).toHaveLength(1)
    expect((row.children[0] as HTMLElement).dataset.testid).toBe('probe')
  })
})
