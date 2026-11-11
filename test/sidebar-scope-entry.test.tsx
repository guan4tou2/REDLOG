// @vitest-environment jsdom
//
// The Targets & Scope row opens the target list, with or without standing
// observations. It used to land on the scope tab while any stood — and
// observations persist, so Targets could never be opened from it in one click
// (and e2e's openView(page, 'targets') timed out waiting for it).

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
  it('opens the target list while observations stand, and still shows their count', async () => {
    const onNavigate = mount(3)
    await waitFor(() => expect(row().textContent).toContain('3'))
    fireEvent.click(row())
    expect(onNavigate).toHaveBeenCalledWith('targets')
  })

  it('opens the target list when none stand', async () => {
    const onNavigate = mount(0)
    await new Promise((r) => setTimeout(r, 20))
    fireEvent.click(row())
    expect(onNavigate).toHaveBeenCalledWith('targets')
  })
})
