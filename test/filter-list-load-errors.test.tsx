// @vitest-environment jsdom
import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilterBar } from '../src/renderer/src/components/FilterBar'
import { FilterProvider, useSharedFilter } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { installTimelineBridge } from './helpers/timeline-bridge'

// An empty filter menu and a menu whose load failed looked identical. Both
// `refreshLists` and the scope read had a bare `catch(() => {})`, so a failed
// first load left the target and type menus empty — which reads as "this
// project has no targets" — and a failed refresh left the previous values on
// screen with nothing to say they were stale.

let api: ReturnType<typeof useSharedFilter>
function Probe(): null { api = useSharedFilter(); return null }

const mount = (): void => {
  render(<I18nProvider><FilterProvider><Probe /><FilterBar /></FilterProvider></I18nProvider>)
}

/** The bar's menus live behind the expander. */
const expand = async (): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: /Filter/i }))
}

describe('the filter menus say when they could not load', () => {
  beforeEach(() => { installTimelineBridge(); try { localStorage.clear() } catch { /* ignore */ } })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('reports a failed load and offers a retry that recovers', async () => {
    const events = (window as unknown as { redlog: { events: Record<string, unknown> } }).redlog.events
    let fail = true
    events.aggregateTargets = vi.fn(async () => {
      if (fail) throw new Error('db gone')
      return [{ target: '10.0.0.5', eventCount: 3 }]
    })
    mount()
    await waitFor(() => expect(api.listsStatus).toBe('error'))
    await expand()
    expect(await screen.findByTestId('filter-lists-error')).not.toBeNull()

    fail = false
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }))
    await waitFor(() => expect(api.listsStatus).toBe('ready'))
    await waitFor(() => expect(screen.queryByTestId('filter-lists-error')).toBeNull())
    expect(api.knownTargets).toEqual([{ target: '10.0.0.5', eventCount: 3 }])
  })

  it('keeps what loaded before when a refresh fails, rather than blanking the menus', async () => {
    const events = (window as unknown as { redlog: { events: Record<string, unknown> } }).redlog.events
    let fail = false
    events.aggregateTargets = vi.fn(async () => {
      if (fail) throw new Error('db gone')
      return [{ target: '10.0.0.5', eventCount: 3 }]
    })
    mount()
    await waitFor(() => expect(api.listsStatus).toBe('ready'))
    expect(api.knownTargets).toHaveLength(1)

    fail = true
    api.retryLists()
    await waitFor(() => expect(api.listsStatus).toBe('error'))
    // Stale and labelled beats empty and silent.
    expect(api.knownTargets).toEqual([{ target: '10.0.0.5', eventCount: 3 }])
  })

  it('does not disturb the operator\'s current selection when a load fails', async () => {
    const events = (window as unknown as { redlog: { events: Record<string, unknown> } }).redlog.events
    events.aggregateTargets = vi.fn(async () => { throw new Error('db gone') })
    mount()
    await waitFor(() => expect(api.listsStatus).toBe('error'))
    api.setAgentType('shell')
    await waitFor(() => expect(api.filter.agentType).toBe('shell'))
    api.retryLists()
    await waitFor(() => expect(api.listsStatus).toBe('error'))
    expect(api.filter.agentType).toBe('shell')
  })

  it('reports a failed scope read separately from the menus', async () => {
    const cfg = (window as unknown as { redlog: { config: Record<string, unknown> } }).redlog.config
    cfg.get = vi.fn(async () => { throw new Error('no config') })
    mount()
    await waitFor(() => expect(api.scopeStatus).toBe('error'))
    await expand()
    expect(await screen.findByTestId('filter-lists-error')).not.toBeNull()
  })

  // #223: the retry button only reloaded the menus, so a failed scope read
  // stayed failed however often it was pressed.
  it('retries the scope read too, and recovers it', async () => {
    const cfg = (window as unknown as { redlog: { config: Record<string, unknown> } }).redlog.config
    let fail = true
    cfg.get = vi.fn(async () => {
      if (fail) throw new Error('no config')
      return { scope: { targets: ['10.10.11.0/24'], excludeTargets: [], personalDomains: [] } }
    })
    mount()
    await waitFor(() => expect(api.scopeStatus).toBe('error'))
    await expand()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }))
    await waitFor(() => expect(api.scopeStatus).toBe('ready'))
    expect(api.scopeTargets).toEqual(['10.10.11.0/24'])
    await waitFor(() => expect(screen.queryByTestId('filter-lists-error')).toBeNull())
  })

  // #223: under React.StrictMode (development) the provider is mounted,
  // cleaned up and mounted again. The live flag only ever went false, so
  // every reply after that was dropped and the filters never loaded.
  it('loads under React.StrictMode', async () => {
    const events = (window as unknown as { redlog: { events: Record<string, unknown> } }).redlog.events
    events.aggregateTargets = vi.fn(async () => [{ target: '10.0.0.5', eventCount: 3 }])
    render(<StrictMode><I18nProvider><FilterProvider><Probe /><FilterBar /></FilterProvider></I18nProvider></StrictMode>)
    await waitFor(() => expect(api.listsStatus).toBe('ready'))
    await waitFor(() => expect(api.scopeStatus).toBe('ready'))
    expect(api.knownTargets).toEqual([{ target: '10.0.0.5', eventCount: 3 }])
  })

  it('is ready, not failed, when the project genuinely has nothing yet', async () => {
    mount()
    await waitFor(() => expect(api.listsStatus).toBe('ready'))
    expect(api.knownTargets).toEqual([])
    await expand()
    expect(screen.queryByTestId('filter-lists-error')).toBeNull()
  })
})
