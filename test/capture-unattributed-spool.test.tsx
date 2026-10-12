// @vitest-environment jsdom
//
// #255: commands typed while no project was open are spooled without an
// engagement identity and set aside by replay. The Capture Health card now says
// how many, and when — and says nothing when there are none, so the line is
// never wallpaper.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { CaptureHealthCard } from '../src/renderer/src/components/CaptureHealth'
import { ConfirmDialogContainer } from '../src/renderer/src/components/ConfirmDialog'

const LINE = '[data-testid="capture-unattributed-spool"]'

function draw(
  unattributedSpool: { count: number; oldestAt: number; newestAt: number } | null,
  onRefresh: () => void = () => {}
): HTMLElement {
  const capture = {
    verdict: 'healthy',
    hasRecorded: true,
    sources: [],
    lastEventAt: null,
    checkedAt: 1,
    dbErrorTotal: 0,
    dbErrorFirstAt: null,
    unattributedSpool
  }
  return render(
    <I18nProvider>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <CaptureHealthCard capture={capture as any} onNavigate={() => {}} onRefresh={onRefresh} />
      <ConfirmDialogContainer />
    </I18nProvider>
  ).container
}

describe('the unattributed-spool line on the Capture Health card', () => {
  beforeEach(() => {
    ;(window as unknown as { redlog: unknown }).redlog = {
      config: { get: async () => ({}), save: async () => true },
      hooks: { install: async () => ({ success: true, message: '' }), uninstall: async () => ({ success: true, message: '' }) }
    }
  })
  afterEach(() => cleanup())

  it('is not there when nothing was set aside', () => {
    expect(draw(null).querySelector(LINE)).toBeNull()
  })

  it('says how many commands are missing and over what span', () => {
    const el = draw({ count: 8, oldestAt: Date.UTC(2026, 9, 12, 2, 0, 0), newestAt: Date.UTC(2026, 9, 12, 9, 30, 0) })
    const text = el.querySelector(LINE)?.textContent ?? ''
    expect(text).toMatch(/8 command\(s\) typed while no project was open/)
    expect(text).toMatch(/not in the record/)
    // A span, not one stamp: two different times appear.
    expect(text).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}.* – .*\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  })

  it('shows a single time when they all share one minute', () => {
    const t = Date.UTC(2026, 9, 12, 2, 0, 0)
    const text = draw({ count: 2, oldestAt: t, newestAt: t + 20_000 }).querySelector(LINE)?.textContent ?? ''
    expect(text).not.toContain(' – ')
  })

  it('tells the operator where the files are, for the one who wants to look', () => {
    const el = draw({ count: 1, oldestAt: 1_700_000_000_000, newestAt: 1_700_000_000_000 })
    expect(el.querySelector(`${LINE} [title]`)?.getAttribute('title')).toMatch(/~\/\.redlog\/pending/)
  })
})

// Clearing them. The files are the only copy of what was typed, so nothing is
// deleted on a click: a graded confirmation first, and the request carries the
// newest time the card was showing so a file set aside meanwhile survives.
describe('clearing the unattributed commands', () => {
  const SPOOL = { count: 3, oldestAt: 1_700_000_000_000, newestAt: 1_700_000_900_000 }
  let clear: ReturnType<typeof vi.fn>
  beforeEach(() => {
    clear = vi.fn(async () => ({ removed: 3, failed: 0 }))
    ;(window as unknown as { redlog: unknown }).redlog = {
      config: { get: async () => ({}), save: async () => true },
      hooks: { install: async () => ({ success: true, message: '' }), uninstall: async () => ({ success: true, message: '' }) },
      capture: { clearUnattributedSpool: clear }
    }
  })
  afterEach(() => cleanup())

  const openDialog = async (el: HTMLElement): Promise<HTMLElement> => {
    fireEvent.click(el.querySelector('[data-testid="capture-unattributed-clear"]')!)
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    return dialog
  }

  it('asks first, says what is deleted, and deletes nothing on a click alone', async () => {
    const el = draw(SPOOL)
    const dialog = await openDialog(el)
    expect(dialog.textContent).toMatch(/Delete 3 unrecorded command file\(s\)\?/)
    expect(dialog.textContent).toMatch(/cannot be recovered/)
    expect(clear).not.toHaveBeenCalled()
    // The confirm button is dead until the box is ticked.
    const confirmBtn = screen.getByRole('button', { name: 'Delete 3' }) as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(true)
  })

  it('deletes only what the card was showing, then asks the card to look again', async () => {
    const onRefresh = vi.fn()
    const el = draw(SPOOL, onRefresh)
    await openDialog(el)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete 3' }))
    await waitFor(() => expect(clear).toHaveBeenCalledWith(SPOOL.newestAt))
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1))
  })

  it('cancelling deletes nothing and does not refresh', async () => {
    const onRefresh = vi.fn()
    const el = draw(SPOOL, onRefresh)
    await openDialog(el)
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(clear).not.toHaveBeenCalled()
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('still refreshes when some files could not be deleted, so the count is the true one', async () => {
    clear.mockResolvedValueOnce({ removed: 2, failed: 1 })
    const onRefresh = vi.fn()
    const el = draw(SPOOL, onRefresh)
    await openDialog(el)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete 3' }))
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1))
  })
})
