// @vitest-environment jsdom
// Marking a finding is the core action, so its failure must be loud and
// must not cost the operator what they typed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const toast = vi.fn()
vi.mock('../src/renderer/src/components/Toast', () => ({ toast: (...a: unknown[]) => toast(...a) }))
vi.mock('../src/renderer/src/i18n', () => ({ useI18n: () => ({ t: (k: string) => k }) }))

import EventMarker from '../src/renderer/src/components/EventMarker'

const create = vi.fn()
const capture = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { redlog: unknown }).redlog = {
    cdp: { getTab: vi.fn().mockResolvedValue(null) },
    marker: { create },
    screenshot: { capture }
  }
})
afterEach(cleanup)

const typeTitle = (text: string): void => {
  fireEvent.change(screen.getByPlaceholderText('marker.placeholder'), { target: { value: text } })
}

describe('saving a new marker', () => {
  it('keeps the dialog and the draft when the save fails, and says so', async () => {
    create.mockRejectedValue(new Error('db locked'))
    const onClose = vi.fn()
    render(<EventMarker onClose={onClose} />)
    typeTitle('got a shell')
    fireEvent.click(screen.getByRole('button', { name: 'marker.submit' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('marker.saveFailed', expect.objectContaining({ type: 'error', detail: 'db locked' })))
    expect(onClose).not.toHaveBeenCalled()
    expect((screen.getByPlaceholderText('marker.placeholder') as HTMLInputElement).value).toBe('got a shell')
    // The button is usable again.
    expect((screen.getByRole('button', { name: 'marker.submit' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('confirms a save, and reports a failed screenshot separately without undoing the marker', async () => {
    create.mockResolvedValue({ id: 'm1' })
    capture.mockRejectedValue(new Error('no display'))
    const onClose = vi.fn()
    render(<EventMarker onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'marker.submit' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(toast).toHaveBeenCalledWith('marker.saved', 'success')
    expect(toast).toHaveBeenCalledWith('marker.screenshotFailed', expect.objectContaining({ type: 'warning', why: 'no display' }))
  })

  it('does not throw a draft away on a stray backdrop click', () => {
    const onClose = vi.fn()
    const { container } = render(<EventMarker onClose={onClose} />)
    const backdrop = container.firstElementChild as HTMLElement
    typeTitle('draft')
    fireEvent.click(backdrop)
    expect(onClose).not.toHaveBeenCalled()
    typeTitle('')
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalled()
  })

  it('exposes the chosen severity to assistive tech', () => {
    render(<EventMarker onClose={() => {}} />)
    const critical = screen.getByRole('button', { name: 'marker.severity.critical' })
    expect(critical.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(critical)
    expect(critical.getAttribute('aria-pressed')).toBe('true')
  })
})
