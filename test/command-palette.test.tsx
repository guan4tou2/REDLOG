// @vitest-environment jsdom
//
// ⌘K (UIUX-STANDARD §10). The palette replaced a whole sidebar page, so the
// things that page did — and the things it never did — both have to work here.

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { CommandPalette } from '../src/renderer/src/components/CommandPalette'
import { toast, toastUndo } from '../src/renderer/src/components/Toast'

vi.mock('../src/renderer/src/components/Toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/src/components/Toast')>()),
  toast: vi.fn(),
  toastUndo: vi.fn()
}))

const bridge = {
  project: { list: vi.fn(async () => []), open: vi.fn(async () => null) },
  events: {
    runQuery: vi.fn(async () => ({ items: [], hasMore: false, nextCursor: null })),
    distinctHosts: vi.fn(async () => [])
  },
  operators: { list: vi.fn(async () => [
    { id: 'op1', name: 'alice', isPrimary: true, createdAt: 0, revokedAt: null },
    { id: 'op2', name: 'bob', isPrimary: false, createdAt: 0, revokedAt: null },
    { id: 'op3', name: 'carol-revoked', isPrimary: false, createdAt: 0, revokedAt: 1 }
  ]) },
  recording: { toggle: vi.fn(async () => false) },
  screenshot: { capture: vi.fn(async () => null) }
}

beforeEach(() => {
  ;(window as unknown as { redlog: typeof bridge }).redlog = bridge
  vi.clearAllMocks()
})
afterEach(() => {
  cleanup()
  // A test that fails between useFakeTimers() and useRealTimers() would
  // otherwise leave fake timers installed, and every later waitFor() would
  // hang to its timeout — failures that are about the leak, not the test.
  vi.useRealTimers()
})

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
    // The numbers are the point: the palette teaches the chord while being
    // used. Asserted without the glyph — under jsdom there is no preload
    // bridge, so `lib/platform` correctly answers "not a Mac" and the hints
    // read `Ctrl+N`. Pinning `⌘` here would only pin the test machine.
    const hints = options
      .map((o) => o.querySelector('.font-mono')?.textContent ?? '')
      .filter(Boolean)
    expect(hints.filter((h) => /(?:⌘|Ctrl\+)1$/.test(h))).toHaveLength(1)
    // ⌘9 is Settings'. The ninth sidebar row must not claim it — advertising
    // a key that does something else is worse than advertising none.
    expect(hints.filter((h) => /(?:⌘|Ctrl\+)9$/.test(h))).toHaveLength(1)
    const marks = screen.getByText(/marks/i).closest('[role="option"]')
    expect(marks?.textContent).not.toMatch(/(?:⌘|Ctrl\+)\d/)
  })

  // The status bar, ⌘. and this palette all pause and resume recording, with
  // three kinds of feedback — and this one gave none: a failed toggle was
  // swallowed, so the operator could believe capture had paused.
  it('reports a failed recording toggle, like the status bar', async () => {
    bridge.recording.toggle.mockRejectedValueOnce(new Error('main did not apply it'))
    open({ recording: true })
    fireEvent.click(await screen.findByText(/pause recording/i))
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't change recording state", expect.objectContaining({ type: 'error' })))
  })

  it('offers the status bar’s undo after pausing', async () => {
    open({ recording: true })
    fireEvent.click(await screen.findByText(/pause recording/i))
    await waitFor(() => expect(toastUndo).toHaveBeenCalledWith('Recording paused', expect.any(Function), expect.objectContaining({ type: 'warning' })))
  })

  // A manual capture returns null when nothing new was stored — the screen
  // matched the last capture, or capturing failed. Neither is "captured".
  it('does not report a screenshot that was not saved', async () => {
    open()
    fireEvent.click(await screen.findByText('Capture Now'))
    await waitFor(() => expect(toast).toHaveBeenCalled())
    expect(toast).not.toHaveBeenCalledWith('Screenshot captured', 'success')
  })

  // Constitution IV: the palette shows the newest 40 matches. When the store has
  // more, the list must say it is a subset rather than read as the answer.
  it('says when its event matches are only the newest ones', async () => {
    bridge.events.runQuery.mockResolvedValueOnce({
      items: [{ id: 'e1', timestamp: 1, agentType: 'shell', data: { command: 'nmap -sV' } }],
      hasMore: true, nextCursor: 'more'
    } as never)
    open()
    type('nmap')
    expect(await screen.findByTestId('palette-search-subset')).toBeTruthy()
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
    expect(bridge.events.runQuery, 'one character is not a search').not.toHaveBeenCalled()

    type('adm')
    expect(bridge.events.runQuery, 'not on the keystroke').not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(bridge.events.runQuery).toHaveBeenCalledTimes(1)
    const req = bridge.events.runQuery.mock.calls[0][0] as { parsed: { text: string }; limit: number }
    expect(req.parsed.text).toBe('adm')
    expect(req.limit).toBe(40)
    vi.useRealTimers()
  })

  // Spec 026: the palette is one of the places an investigation starts, so it
  // answers the same query language Search and the Transcript do.
  it('sends an identifier as a condition, like Search and the Transcript', async () => {
    vi.useFakeTimers()
    open()
    type('session:S1')
    await act(async () => { vi.advanceTimersByTime(200) })
    const req = bridge.events.runQuery.mock.calls[0][0] as { parsed: { conditions: unknown[]; text: string } }
    expect(req.parsed.conditions).toEqual([{ field: 'session', value: 'S1' }])
    expect(req.parsed.text).toBe('')
    vi.useRealTimers()
  })

  it('says the search failed rather than that nothing matched', async () => {
    bridge.events.runQuery.mockRejectedValueOnce(new Error('database is locked'))
    vi.useFakeTimers()
    open()
    type('admin')
    await act(async () => { vi.advanceTimersByTime(200) })
    vi.useRealTimers()
    expect(await screen.findByTestId('palette-search-failed')).toBeTruthy()
    // "No matches for admin" would be a claim about the engagement the palette
    // could not make — the query never answered.
    expect(screen.queryByText(/no matches/i)).toBeNull()
  })

  it('does not run a half-typed condition, and says why', async () => {
    vi.useFakeTimers()
    open()
    type('session:')
    await act(async () => { vi.advanceTimersByTime(500) })
    vi.useRealTimers()
    expect(bridge.events.runQuery).not.toHaveBeenCalled()
    expect(await screen.findByTestId('palette-search-unparsable')).toBeTruthy()
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
})

describe('operator search', () => {
  it('offers live operators and filters the timeline to one', async () => {
    // §10 lists operator among what ⌘K covers, and it needs no aggregation and
    // no loaded timeline — `operators:list` is a plain registry read.
    const { onNavigate } = open()
    type('alice')
    const option = await screen.findByRole('option')
    expect(option.textContent).toMatch(/alice/)

    const dispatched: string[] = []
    window.addEventListener('redlog:filter-operator', (e) => {
      dispatched.push((e as CustomEvent<string>).detail)
    })
    fireEvent.click(option)
    expect(onNavigate).toHaveBeenCalledWith('timeline')
    // The recorded operator id, which the Timeline reads as `operator:op1`
    // (spec 033); a display name can change and the text index never held it.
    await waitFor(() => expect(dispatched).toEqual(['op1']))
  })

  it('leaves revoked operators out', async () => {
    // A revoked key cannot produce new events, so offering it as a filter
    // promises a view that can only ever shrink.
    open()
    type('carol')
    await waitFor(() => expect(screen.queryAllByRole('option')).toHaveLength(0))
  })
})
