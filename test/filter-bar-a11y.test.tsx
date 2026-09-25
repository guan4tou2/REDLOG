// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FilterBar } from '../src/renderer/src/components/FilterBar'
import { FilterProvider, useSharedFilter } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { installTimelineBridge } from './helpers/timeline-bridge'

// Assistive technology had no way to read the state of this bar: the expander
// did not say whether the panel was open or what it controlled, two of the
// three toggles reported as plain buttons, and every chip's clear button
// announced the same untranslated "Clear" without naming what it removed.
// The tier switch already carried aria-pressed (Spec 038) and must keep it.

let api: ReturnType<typeof useSharedFilter>
function Probe(): null { api = useSharedFilter(); return null }
const mount = (): void => {
  render(<I18nProvider><FilterProvider><Probe /><FilterBar /></FilterProvider></I18nProvider>)
}

describe('the filter bar reports its own state', () => {
  beforeEach(() => { installTimelineBridge(); try { localStorage.clear() } catch { /* ignore */ } })
  afterEach(() => cleanup())

  it('says whether the panel is open, and which panel', async () => {
    mount()
    const expander = await screen.findByRole('button', { name: /Filter/i })
    expect(expander.getAttribute('aria-expanded')).toBe('false')
    expect(expander.getAttribute('aria-controls')).toBe('filter-bar-panel')
    fireEvent.click(expander)
    await waitFor(() => expect(expander.getAttribute('aria-expanded')).toBe('true'))
    expect(document.getElementById('filter-bar-panel')).not.toBeNull()
  })

  it('reports every toggle as pressed or not', async () => {
    mount()
    await waitFor(() => expect(api).toBeTruthy())
    const tier = await screen.findByRole('button', { name: /Chained only/i })
    expect(tier.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(tier)
    await waitFor(() => expect(tier.getAttribute('aria-pressed')).toBe('true'))
  })

  it('names the condition a chip clears, in the operator\'s language', async () => {
    mount()
    await waitFor(() => expect(api).toBeTruthy())
    api.setAgentType('shell')
    // The chip label is "Type: Shell"; its clear button must say so rather
    // than a bare "Clear" shared with every other chip.
    const clear = await screen.findByRole('button', { name: /Clear .*Shell/i })
    expect(clear).not.toBeNull()
    fireEvent.click(clear)
    await waitFor(() => expect(api.filter.agentType).toBeNull())
  })
})
