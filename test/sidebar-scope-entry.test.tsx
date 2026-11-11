// @vitest-environment jsdom
//
// With violations standing, the Targets & Scope row opens the scope tab where
// they are listed; with none it opens the target list as before.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import Sidebar from '../src/renderer/src/components/Sidebar'

afterEach(cleanup)

function mount(standing: number): ReturnType<typeof vi.fn> {
  ;(window as unknown as { redlog: unknown }).redlog = {
    loot: { getCount: async () => 0 },
    chain: { length: async () => 0 },
    scope: { getObservationCount: async () => standing, isConfigured: async () => true },
    events: { getCount: async () => 0, onNewBatch: () => () => {} }
  }
  const onNavigate = vi.fn()
  render(<I18nProvider><Sidebar active="dashboard" onNavigate={onNavigate} /></I18nProvider>)
  return onNavigate
}
const row = (): HTMLElement => document.querySelector('[data-view-btn="targets"]') as HTMLElement

describe('sidebar Targets & Scope row', () => {
  it('opens the scope tab while violations stand', async () => {
    const onNavigate = mount(3)
    await waitFor(() => expect(row().textContent).toContain('3'))
    fireEvent.click(row())
    expect(onNavigate).toHaveBeenCalledWith('scope')
  })

  it('opens the target list when none stand', async () => {
    const onNavigate = mount(0)
    await new Promise((r) => setTimeout(r, 20))
    fireEvent.click(row())
    expect(onNavigate).toHaveBeenCalledWith('targets')
  })
})
