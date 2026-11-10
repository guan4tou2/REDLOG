// @vitest-environment jsdom
//
// Spec 069 T019: the screenshots page as a list or a grid, with the trigger
// filter and a search over what is loaded. A deleted file keeps its row and
// says the event record is kept.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
const mount = (): void => { render(<I18nProvider><ScreenshotsView onNavigate={() => {}} /></I18nProvider>) }
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

it('keeps a deleted file as a row that says the event record is kept, with no actions', async () => {
  install()
  window.redlog.events.onNewBatch = ((cb: (e: unknown[]) => void) => {
    setTimeout(() => cb([{ agentType: 'system', data: { subtype: 'screenshot_deleted', source_event: 's1' } }]), 0)
    return () => {}
  }) as never
  mount()
  await screen.findByTestId('screenshot-list')
  await waitFor(() => expect(screen.getAllByText('File deleted · event record kept').length).toBeGreaterThan(0))
  expect(screen.getAllByTestId('screenshot-delete')).toHaveLength(2)
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

// Stitch 03: a section heading, actions named in words, and a state tag on each row.
it('names the section, labels each row recorded, and names its actions in words', async () => {
  install()
  mount()
  await screen.findByTestId('screenshot-list')
  expect(screen.getByText('Screenshot records')).toBeTruthy()
  expect(screen.getAllByTestId('screenshot-state')[0].textContent).toBe('Screenshot recorded')
  expect(screen.getAllByTestId('screenshot-delete')[0].textContent).toBe('Delete file')
  expect(screen.getAllByTestId('screenshot-copy-hash')[0].textContent).toBe('Copy hash')
  expect(screen.getByTestId('screenshots-time-zone').textContent).toMatch(/^Time: (local|UTC)$/)
})

it('replaces an image that fails to load with a placeholder, in list and grid, and drops the actions that need the file', async () => {
  install()
  mount()
  await screen.findByTestId('screenshot-list')
  for (const view of ['list', 'grid']) {
    if (view === 'grid') fireEvent.click(screen.getByTestId('screenshots-view-grid'))
    await waitFor(() => expect(document.querySelectorAll('img').length).toBe(3))
    expect(screen.getAllByTestId('screenshot-enlarge')).toHaveLength(3)
    fireEvent.error(document.querySelectorAll('img')[0])
    expect(screen.getAllByTestId('screenshot-unreadable')).toHaveLength(1)
    expect(screen.getByText('Image unavailable')).toBeTruthy()
    expect(document.querySelectorAll('img').length).toBe(2)
    expect(screen.getAllByTestId('screenshot-enlarge')).toHaveLength(2)
    expect(screen.getAllByTestId('screenshot-reveal')).toHaveLength(2)
    // Copy hash and delete stay; the load failure is not the "deleted" state.
    expect(screen.getAllByTestId('screenshot-copy-hash')).toHaveLength(3)
    expect(screen.getAllByTestId('screenshot-delete')).toHaveLength(3)
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
  expect(screen.queryByTestId('screenshot-enlarge')).toBeNull()
  expect(screen.queryByTestId('screenshot-reveal')).toBeNull()
  expect(screen.getByTestId('screenshot-copy-hash')).toBeTruthy()
})
