// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import PluginsPanel from '../src/renderer/src/components/settings/PluginsPanel'
import en from '../src/renderer/src/i18n/en.json'

// Spec 065 batch A: search, the needs-attention filter, the list/detail split.

const t = (key: string, vars?: Record<string, string | number>): string =>
  ((en as Record<string, string>)[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars?.[k] ?? ''))

// Simulated container widths: null (jsdom has no layout) and a narrow value.
const width = { value: NaN }
vi.mock('../src/renderer/src/hooks/useContainerWidth', () => ({
  useContainerWidth: () => [() => undefined, width.value]
}))

const api = { officialAgents: vi.fn(), installOfficialAgent: vi.fn(), uninstallOfficialAgent: vi.fn(), list: vi.fn(), reload: vi.fn(), openFolder: vi.fn(), setEnabled: vi.fn(), grant: vi.fn(), revoke: vi.fn() }
const draw = (): void => {
  ;(window as unknown as { redlog: unknown }).redlog = { plugins: api }
  render(<PluginsPanel t={t} />)
}
const view = (id: string, over: Record<string, unknown> = {}) => ({
  officialAgent: false, id, name: `Plugin ${id}`, version: '1.0.0', description: over.description ?? '', author: 'me',
  source: 'user' as const, tier: 'declarative' as const, status: 'active' as const, capabilities: [], contributes: [], ...over
})

describe('plugin page — batch A', () => {
  beforeEach(() => { width.value = NaN; Object.values(api).forEach((f) => f.mockReset()); api.officialAgents.mockResolvedValue([]) })
  afterEach(() => cleanup())

  describe('search', () => {
    it('narrows to the plugins whose name, id or description matches, and says when none do', async () => {
      api.list.mockResolvedValue([view('alpha', { description: 'network scanner' }), view('beta')])
      draw()
      await screen.findByText('Plugin alpha')
      const input = screen.getByTestId('plugin-search')
      fireEvent.change(input, { target: { value: 'alpha' } })
      expect(screen.getByText('Plugin alpha')).toBeTruthy()
      expect(screen.queryByText('Plugin beta')).toBeNull()
      fireEvent.change(input, { target: { value: 'scanner' } })
      expect(screen.getByText('Plugin alpha')).toBeTruthy()
      fireEvent.change(input, { target: { value: 'nope' } })
      expect(screen.queryByText('Plugin alpha')).toBeNull()
      expect(screen.getByText(en['plugins.noSearchResults'])).toBeTruthy()
    })
    it('matches multiple whitespace-separated terms together', async () => {
      api.list.mockResolvedValue([view('alpha', { description: 'azure loot' }), view('beta', { description: 'aws loot' })])
      draw()
      await screen.findByText('Plugin alpha')
      fireEvent.change(screen.getByTestId('plugin-search'), { target: { value: 'alpha azure' } })
      expect(screen.getByText('Plugin alpha')).toBeTruthy()
      expect(screen.queryByText('Plugin beta')).toBeNull()
    })
    it('an empty list is the empty state, not a search miss', async () => {
      api.list.mockResolvedValue([])
      draw()
      expect(await screen.findByText(en['plugins.empty'])).toBeTruthy()
      expect(screen.queryByText(en['plugins.noSearchResults'])).toBeNull()
    })
  })

  describe('needs-attention filter', () => {
    it('keeps only the rows with an issue and counts them', async () => {
      api.list.mockResolvedValue([view('ready', { status: 'disabled' }), view('pending', { status: 'needs-consent' })])
      draw()
      await screen.findByText('Plugin ready')
      expect(screen.getByText(en['plugins.filterAttention'] + ' (1)')).toBeTruthy()
      fireEvent.click(screen.getByTestId('plugin-attention-toggle'))
      expect(screen.getByText('Plugin pending')).toBeTruthy()
      expect(screen.queryByText('Plugin ready')).toBeNull()
    })
    it('says everything is handled rather than showing an empty list', async () => {
      api.list.mockResolvedValue([view('ready'), view('also-clean')])
      draw()
      await screen.findByText('Plugin ready')
      fireEvent.click(screen.getByTestId('plugin-attention-toggle'))
      expect(screen.getByText(en['plugins.allHandled'])).toBeTruthy()
      expect(screen.queryByText('Plugin ready')).toBeNull()
    })
    it('combines with search as an intersection', async () => {
      api.list.mockResolvedValue([view('pending', { status: 'needs-consent' }), view('clean')])
      draw()
      await screen.findByText('Plugin pending')
      fireEvent.click(screen.getByTestId('plugin-attention-toggle'))
      fireEvent.change(screen.getByTestId('plugin-search'), { target: { value: 'clean' } })
      expect(screen.getByText(en['plugins.noSearchResults'])).toBeTruthy()
      fireEvent.change(screen.getByTestId('plugin-search'), { target: { value: 'pending' } })
      expect(screen.getByText('Plugin pending')).toBeTruthy()
    })
  })

  describe('row summary', () => {
    it('shows only the first issue on the row; all of them in the detail', async () => {
      api.list.mockResolvedValue([view('broken', { status: 'error', error: 'bad manifest', profilesError: 'EBUSY' })])
      draw()
      await screen.findByText('Plugin broken')
      expect(screen.getByTestId('plugin-issue-broken').textContent).toBe(en['plugins.issue.error'])
      fireEvent.click(screen.getByTestId('plugin-details-broken'))
      await screen.findByTestId('plugin-issues-broken')
      const items = Array.from(screen.getByTestId('plugin-issues-broken').querySelectorAll('li')).map((li) => li.textContent)
      expect(items).toEqual([en['plugins.issue.error'], en['plugins.issue.profilesStale']])
    })
  })

  describe('detail', () => {
    it('reads the five axes and says when there is no diagnosis yet', async () => {
      api.list.mockResolvedValue([view('alpha', { report: null })])
      draw()
      await screen.findByText('Plugin alpha')
      // Wide layout shows a select hint until a row is chosen.
      expect(screen.getByText(en['plugins.selectHint'])).toBeTruthy()
      fireEvent.click(screen.getByTestId('plugin-details-alpha'))
      const detail = await screen.findByTestId('plugin-detail-alpha')
      for (const axis of ['plugins.axis.trust', 'plugins.axis.install', 'plugins.axis.project', 'plugins.axis.health', 'plugins.axis.effect']) {
        expect(detail.textContent).toContain(t(axis))
      }
      expect(detail.textContent).toContain(en['plugins.unknownDiagnosis'])
    })
    it('puts the operations in the detail when the row is selected (no duplicate controls)', async () => {
      api.list.mockResolvedValue([view('alpha')])
      draw()
      await screen.findByText('Plugin alpha')
      expect(screen.getByRole('button', { name: 'Disable' })).toBeTruthy()
      fireEvent.click(screen.getByTestId('plugin-details-alpha'))
      const detail = await screen.findByTestId('plugin-detail-alpha')
      expect(screen.getByRole('button', { name: 'Disable' })).toBeTruthy()
      expect(Array.from(detail.querySelectorAll('button')).some((b) => b.textContent === 'Disable')).toBe(true)
    })
  })

  describe('narrow layout', () => {
    it('shows the detail instead of the list, with a back entry, once a row is chosen', async () => {
      width.value = 600
      api.list.mockResolvedValue([view('alpha'), view('beta')])
      draw()
      await screen.findByText('Plugin alpha')
      // Narrow layout is the list to start with; the detail has no back control.
      fireEvent.click(screen.getByTestId('plugin-details-alpha'))
      await screen.findByTestId('plugin-detail-alpha')
      expect(screen.queryByText('Plugin beta')).toBeNull()
      fireEvent.click(screen.getByTestId('plugin-back-alpha'))
      expect(await screen.findByText('Plugin beta')).toBeTruthy()
      expect(screen.queryByTestId('plugin-detail-alpha')).toBeNull()
    })
  })
})