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
import { _resetIssues } from '../src/renderer/src/lib/issues'

// Writes that used to reject into nowhere: the failure is said, and the
// surface that started the write does not stay busy.

function install(chain: Record<string, unknown>): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    chain: { anchors: vi.fn(async () => []), verify: vi.fn(), anchorNow: vi.fn(), upgrade: vi.fn(), ...chain }
  }
}

function Panel(): JSX.Element {
  const { t } = useI18n()
  return <IntegrityPanel t={t} />
}

describe('Anchor now when the IPC call rejects', () => {
  afterEach(() => { cleanup(); _resetIssues(); toasts.length = 0 })

  it('returns null and shows the anchor-failed error', async () => {
    install({ anchorNow: vi.fn(async () => { throw new Error('ipc down') }) })
    const t = (k: string): string => k
    expect(await anchorNowWithFeedback(t)).toBeNull()
    expect(toasts).toEqual([{ message: 'settings.anchorFailed', opts: expect.objectContaining({ type: 'error', detail: 'ipc down' }) }])
  })

  it('Settings ▸ Integrity: the button comes back instead of staying busy', async () => {
    install({ anchorNow: vi.fn(async () => { throw new Error('ipc down') }) })
    render(<I18nProvider><Panel /></I18nProvider>)
    const button = screen.getByText('Anchor now').closest('button')!
    fireEvent.click(button)
    await waitFor(() => expect(toasts).toHaveLength(1))
    await waitFor(() => expect(button.disabled).toBe(false))
  })
})
