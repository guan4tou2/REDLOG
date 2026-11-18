// @vitest-environment jsdom
//
// Spec 069 T019: the screenshots page as a list or a grid, with the trigger
// filter and a search over what is loaded. A deleted file keeps its row and
// says the event record is kept.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { ScreenshotsView } from '../src/renderer/src/components/ScreenshotsView'

const shot = (id: string, trigger: string, extra: Record<string, unknown> = {}) => ({
  id, timestamp: 1_000_000 + Number(id.replace(/\D/g, '')), agentType: 'screenshot', targetId: null,
  data: { filename: `${id}.png`, filePath: `/x/${id}.png`, trigger, sha256: `sha-${id}`.padEnd(64, '0'), ...extra }
})
const all = [shot('s1', 'manual'), shot('s2', 'periodic', { diffPercent: 4.2 }), shot('s3', 'manual')]

function install(over: { hasMore?: boolean } = {}): ReturnType<typeof vi.fn> {
  const queryScreenshotPage = vi.fn(async ({ trigger }: { trigger?: string | null }) => ({
    items: trigger ? all.filter((s) => s.data.trigger === trigger) : all, hasMore: over.hasMore ?? false, nextCursor: over.hasMore ? 'n' : null
  }))
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { queryScreenshotPage, onNewBatch: () => () => {} },
    screenshot: { deleteFile: vi.fn(async () => ({ ok: true })) },
    artifacts: { reveal: vi.fn(async () => true) }
  }
  return queryScreenshotPage
}
const mount = (): void => { render(<I18nProvider><ScreenshotsView /></I18nProvider>) }
/** Open a row's preview by the file name in its label, and return the preview. */
const rowOf = (name: RegExp): HTMLElement => screen.getByText(name).closest('[role="button"]') as HTMLElement
const openRow = (name: RegExp): HTMLElement => {
  fireEvent.click(rowOf(name))
  return screen.getByTestId('screenshot-lightbox')
}
beforeEach(() => { window.localStorage.clear(); window.localStorage.setItem('redlog-locale', 'en') })
afterEach(() => cleanup())

it('opens as a list, switches to a grid, and remembers the choice', async () => {
  install()
  mount()
  expect(await screen.findByTestId('screenshot-list')).toBeTruthy()
  expect(screen.queryByTestId('screenshot-grid')).toBeNull()
  fireEvent.click(screen.getByTestId('screenshots-view-grid'))
  expect(screen.getByTestId('screenshot-grid')).toBeTruthy()
  expect(window.localStorage.getItem('redlog-screenshots-view')).toBe('grid')
  cleanup(); mount()
  expect(await screen.findByTestId('screenshot-grid')).toBeTruthy()
})

it('keeps every trigger on offer after filtering to one, so the filter can be left', async () => {
  const query = install()
  mount()
  await screen.findByTestId('screenshot-list')
  fireEvent.click(screen.getByRole('button', { name: /periodic/ }))
  await waitFor(() => expect(screen.getAllByRole('button', { name: /^Screenshot at/ })).toHaveLength(1))
  expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ trigger: 'periodic' }))
  expect(screen.getByRole('button', { name: /manual/ })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /^All/ }))
  await waitFor(() => expect(screen.getAllByRole('button', { name: /^Screenshot at/ })).toHaveLength(3))
})

it('searches file name and hash, and says it only searched what is loaded', async () => {
  install({ hasMore: true })
  mount()
  await screen.findByTestId('screenshot-list')
  fireEvent.change(screen.getByTestId('screenshots-search'), { target: { value: 's2' } })
  expect(screen.getAllByRole('button', { name: /^Screenshot at/ })).toHaveLength(1)
  expect(screen.getByTestId('screenshots-search-scope').textContent).toContain('3 loaded')
  fireEvent.change(screen.getByTestId('screenshots-search'), { target: { value: 'nothing-like-this' } })
  expect(screen.getByText('No screenshot matches')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Clear search and filter' }))
  expect(screen.getAllByRole('button', { name: /^Screenshot at/ })).toHaveLength(3)
})

it('shows the hash as recorded without claiming it was checked', async () => {
  install()
  mount()
  await screen.findByTestId('screenshot-list')
  // Stitch 03: the short hash carries the note in its tooltip.
  const hashes = screen.getAllByTestId('screenshot-hash')
  expect(hashes.length).toBe(3)
  for (const h of hashes) expect(h.getAttribute('title')).toMatch(/not re-checked here/)
})

it('keeps a deleted file as a row that says the event record is kept, and offers only its hash', async () => {
  install()
  window.redlog.events.onNewBatch = ((cb: (e: unknown[]) => void) => {
    setTimeout(() => cb([{ agentType: 'system', data: { subtype: 'screenshot_deleted', source_event: 's1' } }]), 0)
    return () => {}
  }) as never
  mount()
  await screen.findByTestId('screenshot-list')
  await waitFor(() => expect(screen.getAllByText('File deleted · event record kept').length).toBeGreaterThan(0))
  const preview = openRow(/s1\.png/)
  expect(within(preview).getByText('File deleted · event record kept')).toBeTruthy()
  expect(within(preview).getByTestId('screenshot-copy-hash')).toBeTruthy()
  expect(within(preview).queryByTestId('screenshot-delete')).toBeNull()
  expect(within(preview).queryByTestId('screenshot-reveal')).toBeNull()
})

it('shows a failed read as a failure with a retry, not as an empty project', async () => {
  const query = install()
  query.mockRejectedValueOnce(new Error('disk gone'))
  mount()
  expect((await screen.findByTestId('screenshots-load-error')).textContent).toContain('disk gone')
  expect(screen.queryByText('Screenshots will appear here when captured')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByTestId('screenshot-list')).toBeTruthy()
})

// No explanation layers (§26, 2026-11-12 list §F): no section heading and
// hint over the list, no "recorded" tag on every normal row, and no time-zone
// note (the status bar states the zone). Actions are named in words.
it('explains nothing the page already shows, and names its actions in words', async () => {
  install()
  mount()
  await screen.findByTestId('screenshot-list')
  openRow(/s1\.png/)
  expect(screen.queryByText('Screenshot records')).toBeNull()
  expect(screen.queryByText(/Click a screenshot to preview it/)).toBeNull()
  expect(screen.queryByText('Screenshot recorded')).toBeNull()
  expect(screen.queryByTestId('screenshot-state')).toBeNull()
  expect(screen.queryByTestId('screenshots-time-zone')).toBeNull()
  expect(screen.getAllByTestId('screenshot-delete')[0].textContent).toBe('Delete file')
  expect(screen.getAllByTestId('screenshot-copy-hash')[0].textContent).toBe('Copy hash')
})

it('replaces an image that fails to load with a placeholder, in list and grid, and drops the actions that need the file', async () => {
  install()
  mount()
  await screen.findByTestId('screenshot-list')
  for (const view of ['list', 'grid']) {
    if (view === 'grid') fireEvent.click(screen.getByTestId('screenshots-view-grid'))
    await waitFor(() => expect(document.querySelectorAll('img').length).toBe(3))
    const failed = document.querySelectorAll('img')[0]
    const row = failed.closest('[role="button"]') as HTMLElement
    fireEvent.error(failed)
    expect(screen.getAllByTestId('screenshot-unreadable')).toHaveLength(1)
    expect(screen.getByText('Image unavailable')).toBeTruthy()
    expect(document.querySelectorAll('img').length).toBe(2)
    // The row still opens: copy hash and delete stay; the file cannot be
    // shown or revealed. The load failure is not the "deleted" state.
    fireEvent.click(row)
    const preview = screen.getByTestId('screenshot-lightbox')
    expect(within(preview).getByText('Image unavailable')).toBeTruthy()
    expect(within(preview).queryByRole('img')).toBeNull()
    expect(within(preview).queryByTestId('screenshot-reveal')).toBeNull()
    expect(within(preview).getByTestId('screenshot-copy-hash')).toBeTruthy()
    expect(within(preview).getByTestId('screenshot-delete')).toBeTruthy()
    expect(screen.queryByText('File deleted · event record kept')).toBeNull()
    // Reset for the next view: a fresh mount forgets the failure.
    cleanup(); install(); mount()
    await screen.findByTestId(view === 'list' ? 'screenshot-list' : 'screenshot-grid')
  }
})

// The Stitch audit's CI screenshot: an event recorded without its file showed
// its filename in the thumbnail box, which read as a broken image.
it('shows the placeholder, not the filename, for a screenshot with no file path', async () => {
  const bare = { ...shot('s9', 'manual'), data: { filename: 's9.png', trigger: 'manual', sha256: 'sha-s9'.padEnd(64, '0') } }
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { queryScreenshotPage: vi.fn(async () => ({ items: [bare], hasMore: false, nextCursor: null })), onNewBatch: () => () => {} },
    screenshot: { deleteFile: vi.fn(async () => ({ ok: true })) },
    artifacts: { reveal: vi.fn(async () => true) }
  }
  mount()
  expect(await screen.findByTestId('screenshot-unreadable')).toBeTruthy()
  expect(document.querySelectorAll('img').length).toBe(0)
  const preview = openRow(/s9\.png/)
  expect(within(preview).queryByTestId('screenshot-reveal')).toBeNull()
  // No path, no file: nothing for "delete file" to remove.
  expect(within(preview).queryByTestId('screenshot-delete')).toBeNull()
  expect(within(preview).getByTestId('screenshot-copy-hash')).toBeTruthy()
})

// One click target per row: the row opens the preview, where the other
// actions are. The time comes first, with the date when it is not today.
describe('a screenshot row', () => {
  it('is one click target with no buttons inside it', async () => {
    install()
    mount()
    await screen.findByTestId('screenshot-list')
    for (const row of screen.getAllByRole('button', { name: /^Screenshot at/ })) {
      expect(within(row).queryAllByRole('button')).toEqual([])
    }
  })

  it('leads with the time, and the date when it is not today', async () => {
    const today = Date.now() - 60_000
    const shots = [shot('s1', 'manual'), { ...shot('s2', 'manual'), timestamp: today }]
    ;(window as unknown as { redlog: unknown }).redlog = {
      events: { queryScreenshotPage: vi.fn(async () => ({ items: shots, hasMore: false, nextCursor: null })), onNewBatch: () => () => {} },
      screenshot: { deleteFile: vi.fn(async () => ({ ok: true })) }, artifacts: { reveal: vi.fn(async () => true) }
    }
    mount()
    await screen.findByTestId('screenshot-list')
    const lead = (name: RegExp): string => (rowOf(name).querySelector('[data-testid="screenshot-time"]') as HTMLElement).textContent ?? ''
    const first = (name: RegExp): HTMLElement => rowOf(name).querySelector('[data-testid="screenshot-meta"]')!.firstElementChild as HTMLElement
    expect(lead(/s1\.png/)).toMatch(/^1970-01-01 \d\d:\d\d:\d\dZ?$/)
    expect(lead(/s2\.png/)).toMatch(/^\d\d:\d\d:\d\dZ?$/)
    expect(first(/s1\.png/).dataset.testid).toBe('screenshot-time')
  })

  it('shows the short hash without a label, the full one in its title', async () => {
    install()
    mount()
    await screen.findByTestId('screenshot-list')
    const hash = screen.getAllByTestId('screenshot-hash')[0]
    expect(hash.textContent).not.toContain('SHA-256')
    expect(hash.getAttribute('title')).toMatch(/SHA-256: sha-s\d0{58}$/)
  })

  it('opens the preview, which holds reveal, copy hash and delete', async () => {
    install()
    mount()
    await screen.findByTestId('screenshot-list')
    const preview = openRow(/s2\.png/)
    expect(within(preview).getByTestId('screenshot-reveal').textContent).toBe('Show in folder')
    expect(within(preview).getByTestId('screenshot-copy-hash').textContent).toBe('Copy hash')
    expect(within(preview).getByTestId('screenshot-delete').textContent).toBe('Delete file')
  })
})
