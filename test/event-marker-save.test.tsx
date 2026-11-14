// @vitest-environment jsdom
// Marking a finding is the core action, so its failure must be loud and
// must not cost the operator what they typed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const toast = vi.fn()
vi.mock('../src/renderer/src/components/Toast', () => ({ toast: (...a: unknown[]) => toast(...a) }))
const i18nT = vi.hoisted(() => ({ fn: (k: string, _v?: Record<string, string | number>): string => k }))
vi.mock('../src/renderer/src/i18n', () => ({ useI18n: () => ({ t: (k: string, v?: Record<string, string | number>) => i18nT.fn(k, v) }) }))

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

describe('the stored default title', () => {
  // The title is inside the row's hash: it must not follow the display zone or
  // the interface language, so `t` here speaks a different language each time
  // and the zone setting changes between runs.
  const locales: Array<[string, (k: string, v?: Record<string, string | number>) => string]> = [
    ['en', (k, v) => (k === 'marker.defaultTitle' ? `Mark @ ${v?.time}` : k)],
    ['zh-TW', (k, v) => (k === 'marker.defaultTitle' ? `標記 @ ${v?.time}` : k)]
  ]
  for (const zone of ['local', 'utc']) {
    for (const [name, tr] of locales) {
      it(`is exactly "Mark" with zone ${zone} and locale ${name}`, async () => {
        localStorage.setItem('redlog-display-zone', zone)
        i18nT.fn = tr
        create.mockResolvedValue({ id: 'm1' })
        capture.mockResolvedValue(null)
        render(<EventMarker onClose={vi.fn()} />)
        fireEvent.click(screen.getByRole('button', { name: 'marker.submit' }))
        await waitFor(() => expect(create).toHaveBeenCalled())
        expect(create.mock.calls[0][0].title).toBe('Mark')
        i18nT.fn = (k) => k
        localStorage.removeItem('redlog-display-zone')
      })
    }
  }

  it('keeps a title the operator typed', async () => {
    create.mockResolvedValue({ id: 'm1' })
    capture.mockResolvedValue(null)
    render(<EventMarker onClose={vi.fn()} />)
    typeTitle('  got a shell ')
    fireEvent.click(screen.getByRole('button', { name: 'marker.submit' }))
    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(create.mock.calls[0][0].title).toBe('got a shell')
  })
})

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

  it('does not save on the Enter that confirms an input-method composition', () => {
    render(<EventMarker onClose={() => {}} />)
    typeTitle('にほんご')
    const field = screen.getByPlaceholderText('marker.placeholder')
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 })
    expect(create).not.toHaveBeenCalled()
    create.mockResolvedValue({ id: 'm1' })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('keeps a typed draft on Escape, and ignores the Escape that cancels a composition', () => {
    const onClose = vi.fn()
    render(<EventMarker onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape', isComposing: true })
    fireEvent.keyDown(window, { key: 'Escape', keyCode: 229 })
    expect(onClose).not.toHaveBeenCalled()
    typeTitle('draft')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    typeTitle('')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
