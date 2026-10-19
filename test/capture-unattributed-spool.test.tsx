// @vitest-environment jsdom
//
// #255: shell commands spooled while no project was open are set aside by
// replay as `*.unattributed` files. They say nothing about the open project's
// capture, so the dashboard's Capture Health card does not show them; Settings ▸
// Retention lists them and offers the one graded way to clear them.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { CaptureHealthCard } from '../src/renderer/src/components/CaptureHealth'
import UnattributedSpoolRow from '../src/renderer/src/components/settings/UnattributedSpoolRow'
import { ConfirmDialogContainer } from '../src/renderer/src/components/ConfirmDialog'
import { useI18n } from '../src/renderer/src/i18n'

const LINE = '[data-testid="capture-unattributed-spool"]'
type Spool = { count: number; oldestAt: number; newestAt: number }

function Row(): JSX.Element {
  const { t } = useI18n()
  return <UnattributedSpoolRow t={t} />
}

let health: ReturnType<typeof vi.fn>
let clear: ReturnType<typeof vi.fn>
function install(spool: Spool | null): void {
  health = vi.fn(async () => ({ unattributedSpool: spool }))
  clear = vi.fn(async () => ({ removed: 3, failed: 0 }))
  ;(window as unknown as { redlog: unknown }).redlog = {
    config: { get: async () => ({}), save: async () => true },
    hooks: { install: async () => ({ success: true, message: '' }), uninstall: async () => ({ success: true, message: '' }) },
    capture: { health, clearUnattributedSpool: clear }
  }
}
async function draw(spool: Spool | null): Promise<HTMLElement> {
  install(spool)
  const el = render(<I18nProvider><Row /><ConfirmDialogContainer /></I18nProvider>).container
  await waitFor(() => expect(health).toHaveBeenCalled())
  return el
}

describe('the dashboard Capture Health card', () => {
  afterEach(() => cleanup())
  it('does not show temp files from before a project was open', () => {
    const capture = {
      verdict: 'healthy', hasRecorded: true, sources: [], lastEventAt: null, checkedAt: 1, dbErrorTotal: 0, dbErrorFirstAt: null,
      unattributedSpool: { count: 605, oldestAt: 1, newestAt: 2 }
    }
    const { container } = render(
      <I18nProvider>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <CaptureHealthCard capture={capture as any} onNavigate={() => {}} onRefresh={() => {}} />
      </I18nProvider>
    )
    expect(container.querySelector(LINE)).toBeNull()
  })
})

describe('the unattributed-spool row in Settings', () => {
  afterEach(() => cleanup())

  it('is not there when nothing was set aside', async () => {
    expect((await draw(null)).querySelector(LINE)).toBeNull()
  })

  it('counts files, not commands, and gives the span', async () => {
    const el = await draw({ count: 8, oldestAt: Date.UTC(2026, 9, 12, 2, 0, 0), newestAt: Date.UTC(2026, 9, 12, 9, 30, 0) })
    await waitFor(() => expect(el.querySelector(LINE)).not.toBeNull())
    const text = el.querySelector(LINE)?.textContent ?? ''
    expect(text).toMatch(/8 temp file\(s\)/)
    expect(text).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}.* – .*\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  })

  it('shows a single time when they all share one minute', async () => {
    const t = Date.UTC(2026, 9, 12, 2, 0, 0)
    const el = await draw({ count: 2, oldestAt: t, newestAt: t + 20_000 })
    await waitFor(() => expect(el.querySelector(LINE)).not.toBeNull())
    expect(el.querySelector(LINE)?.textContent).not.toContain(' – ')
  })

  it('tells the operator where the files are', async () => {
    const el = await draw({ count: 1, oldestAt: 1_700_000_000_000, newestAt: 1_700_000_000_000 })
    await waitFor(() => expect(el.querySelector(`${LINE} [title]`)).not.toBeNull())
    expect(el.querySelector(`${LINE} [title]`)?.getAttribute('title')).toMatch(/~\/\.redlog\/pending/)
  })
})

// Clearing them. The files are the only copy of what was typed, so nothing is
// deleted on a click: a graded confirmation first, and the request carries the
// newest time shown so a file set aside meanwhile survives.
describe('clearing the unattributed files', () => {
  const SPOOL = { count: 3, oldestAt: 1_700_000_000_000, newestAt: 1_700_000_900_000 }
  afterEach(() => cleanup())

  const openDialog = async (el: HTMLElement): Promise<HTMLElement> => {
    await waitFor(() => expect(el.querySelector('[data-testid="capture-unattributed-clear"]')).not.toBeNull())
    fireEvent.click(el.querySelector('[data-testid="capture-unattributed-clear"]')!)
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    return dialog
  }

  it('asks first, says what is deleted, and deletes nothing on a click alone', async () => {
    const dialog = await openDialog(await draw(SPOOL))
    expect(dialog.textContent).toMatch(/Delete 3 unrecorded command file\(s\)\?/)
    expect(dialog.textContent).toMatch(/cannot be recovered/)
    expect(clear).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'Delete 3' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('deletes only what was shown, then looks again', async () => {
    await openDialog(await draw(SPOOL))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete 3' }))
    await waitFor(() => expect(clear).toHaveBeenCalledWith(SPOOL.newestAt))
    await waitFor(() => expect(health).toHaveBeenCalledTimes(2))
  })

  it('cancelling deletes nothing and does not look again', async () => {
    await openDialog(await draw(SPOOL))
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(clear).not.toHaveBeenCalled()
    expect(health).toHaveBeenCalledTimes(1)
  })

  it('still looks again when some files could not be deleted, so the count is the true one', async () => {
    await openDialog(await draw(SPOOL))
    clear.mockResolvedValueOnce({ removed: 2, failed: 1 })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete 3' }))
    await waitFor(() => expect(health).toHaveBeenCalledTimes(2))
  })
})
