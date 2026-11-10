// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CollapsibleStream } from '../src/renderer/src/components/HttpDetail'
import { ToastContainer } from '../src/renderer/src/components/Toast'
import { I18nProvider } from '../src/renderer/src/i18n'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

// The renderer is denied navigator.clipboard (main/index.ts), so the only
// honest copy is the bridge's, and a copy button must say when it failed.
const BIG = 'x'.repeat(5000) // the copy control only exists past the inline preview

function mount(writeText: (text: string) => Promise<boolean>): void {
  ;(window as unknown as { redlog: unknown }).redlog = { clipboard: { writeText } }
  render(<I18nProvider><CollapsibleStream label="stdout" content={BIG} accent="emerald" startOpen /><ToastContainer /></I18nProvider>)
}

describe('copying a stream', () => {
  const copy = (): HTMLElement => screen.getAllByText(/Copy full/i)[0]

  beforeEach(() => {
    // jsdom has no clipboard; if the component reached for it the test would throw.
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
  })

  it('writes through the bridge and says it copied', async () => {
    const write = vi.fn(async () => true)
    mount(write)
    fireEvent.click(copy())
    await waitFor(() => expect(write).toHaveBeenCalledWith(BIG))
    expect(await screen.findByText('Copied to clipboard')).toBeTruthy()
  })

  it('says so when the clipboard refused the write, and does not show "copied"', async () => {
    mount(vi.fn(async () => false))
    fireEvent.click(copy())
    expect(await screen.findByText('Could not copy to clipboard')).toBeTruthy()
    expect(screen.queryByText('Copied to clipboard')).toBeNull()
  })
})
