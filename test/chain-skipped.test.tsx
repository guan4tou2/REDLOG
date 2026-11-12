// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const toasts = vi.hoisted(() => [] as Array<{ message: string; opts: unknown }>)
vi.mock('../src/renderer/src/components/Toast', () => ({
  toast: (message: string, opts: unknown) => { toasts.push({ message, opts }) }
}))

import IntegrityPanel from '../src/renderer/src/components/settings/IntegrityPanel'
import { anchorNowWithFeedback } from '../src/renderer/src/lib/chainActions'
import { I18nProvider, useI18n } from '../src/renderer/src/i18n'
import { _resetIssues, snapshotIssues } from '../src/renderer/src/lib/issues'

// An air-gapped project does not submit an anchor. That is not "nothing to
// anchor" (an error) and not an anchor (a success, with receipts to count).
const SKIPPED = 'Skipped: this project is offline'

function install(chain: Record<string, unknown>): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    chain: { anchors: vi.fn(async () => []), verify: vi.fn(), anchorNow: vi.fn(), upgrade: vi.fn(), ...chain }
  }
}

function Panel(): JSX.Element {
  const { t } = useI18n()
  return <IntegrityPanel t={t} />
}

describe('air-gapped anchoring', () => {
  afterEach(() => { cleanup(); _resetIssues(); toasts.length = 0 })

  it('shows one neutral toast, raises no issue and returns null', async () => {
    install({ anchorNow: vi.fn(async () => ({ skipped: 'offline' })) })
    const t = (k: string): string => ({ 'settings.integritySkippedOffline': SKIPPED }[k] ?? k)
    expect(await anchorNowWithFeedback(t)).toBeNull()
    expect(toasts).toEqual([{ message: SKIPPED, opts: 'info' }])
    expect(snapshotIssues()).toEqual([])
  })

  it('Settings ▸ Integrity: Anchor now does not show the "no anchors" error', async () => {
    install({ anchorNow: vi.fn(async () => ({ skipped: 'offline' })) })
    render(<I18nProvider><Panel /></I18nProvider>)
    fireEvent.click(screen.getByText('Anchor now'))
    await waitFor(() => expect(toasts.map((x) => x.message)).toEqual([SKIPPED]))
  })

  it('Settings ▸ Integrity: upgrade does not read a skipped result as counts', async () => {
    install({ upgrade: vi.fn(async () => ({ skipped: 'offline' })) })
    render(<I18nProvider><Panel /></I18nProvider>)
    fireEvent.click(screen.getByText('Upgrade pending'))
    await waitFor(() => expect(toasts.map((x) => x.message)).toEqual([SKIPPED]))
  })
})
