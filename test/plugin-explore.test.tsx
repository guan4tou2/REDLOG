// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import PluginsPanel from '../src/renderer/src/components/settings/PluginsPanel'
import en from '../src/renderer/src/i18n/en.json'

// Spec 065 batch A: search, the filter tabs, the list/detail pages. Spec 069 T019:
// one column at every width, from the Stitch plugin-management design.

const t = (key: string, vars?: Record<string, string | number>): string =>
  ((en as Record<string, string>)[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars?.[k] ?? ''))

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
  beforeEach(() => { Object.values(api).forEach((f) => f.mockReset()); api.officialAgents.mockResolvedValue([]) })
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
      expect(screen.getByTestId('plugin-filter-attention').textContent).toBe(en['plugins.filterAttention'] + ' (1)')
      fireEvent.click(screen.getByTestId('plugin-filter-attention'))
      expect(screen.getByText('Plugin pending')).toBeTruthy()
      expect(screen.queryByText('Plugin ready')).toBeNull()
    })
    it('says everything is handled rather than showing an empty list', async () => {
      api.list.mockResolvedValue([view('ready'), view('also-clean')])
      draw()
      await screen.findByText('Plugin ready')
      fireEvent.click(screen.getByTestId('plugin-filter-attention'))
      expect(screen.getByText(en['plugins.allHandled'])).toBeTruthy()
      expect(screen.queryByText('Plugin ready')).toBeNull()
    })
    it('combines with search as an intersection', async () => {
      api.list.mockResolvedValue([view('pending', { status: 'needs-consent' }), view('clean')])
      draw()
      await screen.findByText('Plugin pending')
      fireEvent.click(screen.getByTestId('plugin-filter-attention'))
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
      expect(screen.getByText(new RegExp(en['plugins.listHint']))).toBeTruthy()
      fireEvent.click(screen.getByTestId('plugin-details-alpha'))
      const detail = await screen.findByTestId('plugin-detail-alpha')
      for (const axis of ['plugins.axis.trust', 'plugins.axis.install', 'plugins.axis.effect']) {
        expect(detail.textContent).toContain(t(axis))
      }
      // Project and capture health are an official integration's; a plain plugin has
      // no such card to leave empty (Spec 069 T019).
      for (const axis of ['plugins.axis.project', 'plugins.axis.health']) expect(detail.textContent).not.toContain(t(axis))
      expect(detail.textContent).toContain(en['plugins.unknownDiagnosis'])
    })
    it('keeps every control out of the list: they are in the detail, once a row is chosen', async () => {
      api.list.mockResolvedValue([view('alpha')])
      draw()
      await screen.findByText('Plugin alpha')
      expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull()
      fireEvent.click(screen.getByTestId('plugin-details-alpha'))
      const detail = await screen.findByTestId('plugin-detail-alpha')
      expect(Array.from(detail.querySelectorAll('button')).some((b) => b.textContent === 'Disable')).toBe(true)
    })
    it('lists what a plugin asks for as a request, not as an approval', async () => {
      api.list.mockResolvedValue([view('asker', { tier: 'privileged', status: 'needs-consent', capabilities: ['events:write'] })])
      draw()
      fireEvent.click(await screen.findByTestId('plugin-details-asker'))
      const caps = await screen.findByTestId('plugin-capabilities-asker')
      expect(caps.textContent).toContain('events:write')
      expect(caps.textContent).toContain(en['plugins.capabilitiesNote'])
      // No tick beside a capability: asking is not being granted.
      expect(caps.querySelector('svg')).toBeNull()
      expect(caps.textContent).not.toContain('✓')
    })
    it('collapses the specifications, and shows the project card only for an official integration', async () => {
      api.list.mockResolvedValue([view('plain')])
      draw()
      fireEvent.click(await screen.findByTestId('plugin-details-plain'))
      const specs = await screen.findByTestId('plugin-specs-plain') as HTMLDetailsElement
      expect(specs.open).toBe(false)
      expect(screen.queryByTestId('plugin-card-capture-plain')).toBeNull()
    })
  })

  describe('filter tabs', () => {
    it('counts all / installed / official-or-built-in, and filters by them', async () => {
      api.list.mockResolvedValue([view('mine'), view('shipped', { source: 'bundled' })])
      api.officialAgents.mockResolvedValue([{ agentKind: 'codex', pluginId: 'official-ai-codex', name: 'Codex', source: {}, state: 'not-installed' }])
      draw()
      await screen.findByText('Plugin mine')
      const label = (id: string): string | null => screen.getByTestId(`plugin-filter-${id}`).textContent
      expect(label('all')).toBe(`${en['plugins.filter.all']} (3)`)
      // The not-installed integration is listed, but nothing is installed behind it.
      expect(label('installed')).toBe(`${en['plugins.filter.installed']} (2)`)
      expect(label('official')).toBe(`${en['plugins.filter.official']} (2)`)
      fireEvent.click(screen.getByTestId('plugin-filter-installed'))
      expect(screen.queryByText('Codex')).toBeNull()
      expect(screen.getByTestId('plugin-shown-count').textContent).toContain('2')
      fireEvent.click(screen.getByTestId('plugin-filter-official'))
      expect(screen.queryByText('Plugin mine')).toBeNull()
      expect(screen.getByText('Plugin shipped')).toBeTruthy()
    })
  })

  describe('one column at every width', () => {
    it('shows the detail instead of the list, with a way back, once a row is chosen', async () => {
      api.list.mockResolvedValue([view('alpha'), view('beta')])
      draw()
      await screen.findByText('Plugin alpha')
      fireEvent.click(screen.getByTestId('plugin-details-alpha'))
      await screen.findByTestId('plugin-detail-alpha')
      expect(screen.queryByText('Plugin beta')).toBeNull()
      fireEvent.click(screen.getByTestId('plugin-back-alpha'))
      expect(await screen.findByText('Plugin beta')).toBeTruthy()
      expect(screen.queryByTestId('plugin-detail-alpha')).toBeNull()
    })

    it('returns to the place in the list, and refreshing the detail does not move that place', async () => {
      api.list.mockResolvedValue([view('alpha'), view('beta')])
      api.setEnabled.mockResolvedValue([view('alpha', { status: 'disabled' }), view('beta')])
      ;(window as unknown as { redlog: unknown }).redlog = { plugins: api }
      render(<div data-testid="settings-content"><PluginsPanel t={t} /></div>)
      const pane = screen.getByTestId('settings-content')
      await screen.findByText('Plugin alpha')
      pane.scrollTop = 420
      fireEvent.click(screen.getByTestId('plugin-details-alpha'))
      await screen.findByTestId('plugin-detail-alpha')
      expect(pane.scrollTop).toBe(0)
      // A change made inside the detail redraws it from the top of the page…
      pane.scrollTop = 90
      fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
      await screen.findByRole('button', { name: 'Enable' })
      // …and the way back still goes to where the list was, not to 90.
      fireEvent.click(screen.getByTestId('plugin-back-alpha'))
      await screen.findByText('Plugin beta')
      expect(pane.scrollTop).toBe(420)
    })
  })
})
