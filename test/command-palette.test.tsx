// @vitest-environment jsdom
//
// ⌘K (UIUX-STANDARD §10). The palette replaced a whole sidebar page, so the
// things that page did — and the things it never did — both have to work here.

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { CommandPalette } from '../src/renderer/src/components/CommandPalette'

const bridge = {
  project: { list: vi.fn(async () => []), open: vi.fn(async () => null) },
  events: { search: vi.fn(async () => []) },
  recording: { toggle: vi.fn(async () => false) },
  screenshot: { capture: vi.fn(async () => null) }
}

beforeEach(() => {
  ;(window as unknown as { redlog: typeof bridge }).redlog = bridge
  vi.clearAllMocks()
})
afterEach(cleanup)

function open(props: Partial<Parameters<typeof CommandPalette>[0]> = {}): {
  onNavigate: ReturnType<typeof vi.fn>
  onClose: ReturnType<typeof vi.fn>
} {
  const onNavigate = vi.fn()
  const onClose = vi.fn()
  render(
    <I18nProvider>
      <CommandPalette
        open
        onClose={onClose}
        onNavigate={onNavigate}
        onOpenEvent={vi.fn()}
        recording
        {...props}
      />
    </I18nProvider>
  )
  return { onNavigate, onClose }
}

const type = (value: string): void => {
  fireEvent.change(screen.getByRole('textbox'), { target: { value } })
}

describe('command palette', () => {
  it('lists every view with its number, so the shortcut is learnable from here', async () => {
    open()
    const options = await screen.findAllByRole('option')
    expect(options.length).toBeGreaterThan(9)
    // The numbers are the point: the palette teaches ⌘N while being used.
    expect(screen.getByText('⌘1')).toBeTruthy()
    // ⌘9 is Settings'. The ninth sidebar row must not claim it — advertising
    // a key that does something else is worse than advertising none.
    expect(screen.getAllByText('⌘9')).toHaveLength(1)
    const marks = screen.getByText(/marks/i).closest('[role="option"]')
    expect(marks?.textContent).not.toMatch(/⌘\d/)
  })

  it('navigates and closes on Enter', async () => {
    const { onNavigate, onClose } = open()
    await screen.findAllByRole('option')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    expect(onNavigate).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('filters as you type and reports an honest miss', async () => {
    open()
    type('zzzznotathing')
    await waitFor(() => expect(screen.queryAllByRole('option')).toHaveLength(0))
    expect(screen.getByText(/zzzznotathing/)).toBeTruthy()
  })

  it('waits before hitting the database, and not at all for one character', async () => {
    vi.useFakeTimers()
    open()
    type('a')
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(bridge.events.search, 'one character is not a search').not.toHaveBeenCalled()

    type('adm')
    expect(bridge.events.search, 'not on the keystroke').not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(bridge.events.search).toHaveBeenCalledWith('adm', 40)
    vi.useRealTimers()
  })

  it('starts empty every time it opens', async () => {
    // A palette that remembers last time's query makes the operator delete
    // something before they can type.
    const { onClose } = open()
    type('leftover')
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('leftover')
    cleanup()
    void onClose
    open()
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('')
  })

  it('closes on Escape', async () => {
    const { onClose } = open()
    await screen.findAllByRole('option')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('offers pause or resume to match the current state', async () => {
    open({ recording: true })
    expect(await screen.findByText(/pause recording/i)).toBeTruthy()
    cleanup()
    open({ recording: false })
    expect(await screen.findByText(/resume recording/i)).toBeTruthy()
  })

  it('keeps the timeline-scoped palette reachable now that ⌘K is global', async () => {
    // It lost its chord when ⌘K became app-wide. A working feature with no
    // way in is worse than one that was removed on purpose.
    const { onNavigate } = open()
    type('loaded timeline')
    const option = await screen.findByRole('option')
    fireEvent.click(option)
    expect(onNavigate).toHaveBeenCalledWith('timeline')
  })
})
