// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FilterBar } from '../src/renderer/src/components/FilterBar'
import { FilterProvider, useSharedFilter, toEventFilter } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { installTimelineBridge } from './helpers/timeline-bridge'

let filterApi: ReturnType<typeof useSharedFilter>
function Probe(): null { filterApi = useSharedFilter(); return null }

const mount = (): void => {
  render(<I18nProvider><FilterProvider><Probe /><FilterBar /></FilterProvider></I18nProvider>)
}

// Spec 033 US4: "chained only" is a shared-filter condition with an
// always-visible chip, like the other on/off conditions, and it starts at
// "all tiers" whenever a project opens. It was the Timeline's auditor switch,
// remembered per project, and no other view could ask it.
describe('the tier chip', () => {
  beforeEach(() => {
    installTimelineBridge()
    try { localStorage.clear() } catch { /* ignore */ }
  })
  afterEach(() => cleanup())

  it('is always visible, and sets the shared tier', async () => {
    mount()
    const chip = await screen.findByRole('button', { name: /Chained only/ })
    expect(filterApi.filter.tier).toBe('all')
    fireEvent.click(chip)
    await waitFor(() => expect(filterApi.filter.tier).toBe('chained'))
    expect(toEventFilter(filterApi.filter)).toMatchObject({ tier: 'chained' })
    expect(filterApi.activeCount).toBe(1)
    fireEvent.click(chip)
    await waitFor(() => expect(filterApi.filter.tier).toBe('all'))
    expect(toEventFilter(filterApi.filter)).not.toHaveProperty('tier')
  })

  it('starts at all tiers, whatever the Timeline remembered', async () => {
    localStorage.setItem('redlog-timeline-auditor-view:p1', '1')
    mount()
    await screen.findByRole('button', { name: /Chained only/ })
    expect(filterApi.filter.tier).toBe('all')
  })

  it('is cleared with the rest', async () => {
    mount()
    act(() => { filterApi.setTier('chained'); filterApi.setAgentType('dns') })
    await waitFor(() => expect(filterApi.activeCount).toBe(2))
    act(() => { filterApi.clearAll() })
    expect(filterApi.filter.tier).toBe('all')
  })
})
