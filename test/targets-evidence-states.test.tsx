// @vitest-environment jsdom
//
// #691: a target's evidence has a loading, a failed and a loaded state. A
// failed read is not "no events", and target B never shows target A's rows —
// neither while B loads nor when A's reply arrives late.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TargetView } from '../src/renderer/src/components/TargetView'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { installTimelineBridge, makeEvent, page, deferred, type TimelineBridge } from './helpers/timeline-bridge'

const T0 = 1_700_000_000_000
const mountPage = (): void => {
  render(<I18nProvider><FilterProvider><TargetView /></FilterProvider></I18nProvider>)
}
const rowOf = (target: string): HTMLElement => screen.getByText(target)

describe('a target\'s evidence', () => {
  let b: TimelineBridge
  beforeEach(() => {
    window.localStorage.setItem('redlog-locale', 'en')
    b = installTimelineBridge()
    const r = (window as unknown as { redlog: Record<string, Record<string, unknown>> }).redlog
    r.events.aggregateTargets = async () => [
      { target: 'a.test', eventCount: 1, firstSeen: T0, lastSeen: T0 + 2 },
      { target: 'b.test', eventCount: 1, firstSeen: T0, lastSeen: T0 + 1 }
    ]
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear() })

  it('a failed read says so, with a retry — not "no evidence"', async () => {
    b.queryPage.mockRejectedValueOnce(new Error('db locked'))
    mountPage()
    fireEvent.click(await screen.findByText('a.test'))
    expect(await screen.findByTestId('target-evidence-failed')).toBeTruthy()
    expect(screen.queryByText('No evidence linked to this target.')).toBeNull()
    b.queryPage.mockResolvedValueOnce(page([makeEvent('a1', T0, 'shell', { data: { subtype: 'command_end', command: 'nmap a.test' } })]))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText(/nmap a\.test/)).toBeTruthy()
    expect(screen.queryByTestId('target-evidence-failed')).toBeNull()
  })

  it('shows loading, never the previous target\'s rows, and drops a late reply', async () => {
    const aReply = deferred<ReturnType<typeof page>>()
    const bReply = deferred<ReturnType<typeof page>>()
    b.queryPage.mockResolvedValueOnce(page([makeEvent('a0', T0, 'shell', { data: { subtype: 'command_end', command: 'whoami-on-a' } })]))
    mountPage()
    fireEvent.click(await screen.findByText('a.test'))
    expect(await screen.findByText(/whoami-on-a/)).toBeTruthy()
    // Close A, open it again (slow), then switch to B (slow) before A answers.
    fireEvent.click(rowOf('a.test'))
    b.queryPage.mockReturnValueOnce(aReply.promise).mockReturnValueOnce(bReply.promise)
    fireEvent.click(rowOf('a.test'))
    fireEvent.click(rowOf('b.test'))
    expect(screen.getByTestId('target-evidence-loading')).toBeTruthy()
    expect(screen.queryByText(/whoami-on-a/)).toBeNull()
    await act(async () => { aReply.resolve(page([makeEvent('a1', T0, 'shell', { data: { subtype: 'command_end', command: 'late-a-row' } })])) })
    expect(screen.queryByText(/late-a-row/)).toBeNull()
    await act(async () => { bReply.resolve(page([makeEvent('b1', T0, 'shell', { data: { subtype: 'command_end', command: 'curl b.test' } })])) })
    await waitFor(() => expect(screen.getByText(/curl b\.test/)).toBeTruthy())
    expect(screen.queryByText(/late-a-row/)).toBeNull()
  })

  it('names event types with the shared label, not the raw agent type', async () => {
    b.queryPage.mockResolvedValueOnce(page([makeEvent('s1', T0, 'scanner', { data: { subtype: 'http_response', status: 200 } })]))
    mountPage()
    fireEvent.click(await screen.findByText('a.test'))
    expect(await screen.findByText('Network: 1')).toBeTruthy()
    expect(screen.queryByText('scanner: 1')).toBeNull()
  })
})
