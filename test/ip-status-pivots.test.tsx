// @vitest-environment jsdom
//
// Spec 069 T019 (dashboard): relay nodes are listed as detected, never drawn as
// a route, and their read is independent of the IP read and of "none".

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import IPStatusCard from '../src/renderer/src/components/IPStatusCard'

type Pivot = { via: string; tool: string; route?: string; ts: number }
const NOW = Date.now()
const two: Pivot[] = [
  { via: '192.0.2.24:11601', tool: 'ligolo-ng', route: '172.16.10.0/24', ts: NOW - 35_000 },
  { via: '127.0.0.1:1080', tool: 'ssh -D', ts: NOW - 5_000 }
]
const ip = { externalIP: '203.0.113.18', internalIP: '10.0.2.15', ipSafety: 'unknown', lastCheck: NOW }

let change: (p: Pivot[]) => void = () => {}
function install(opts: { ip?: 'ok' | 'fail'; pivots?: 'ok' | 'fail'; list?: Pivot[] }): void {
  const getActive = vi.fn(async () => { if (opts.pivots === 'fail') throw new Error('x'); return opts.list ?? [] })
  ;(window as unknown as { redlog: unknown }).redlog = {
    ip: {
      getStatus: vi.fn(async () => { if (opts.ip === 'fail') throw new Error('x'); return ip }),
      onStatus: () => () => {}
    },
    pivots: { getActive, onChange: (cb: (p: Pivot[]) => void) => { change = cb; return () => {} } }
  }
}
const mount = (): void => { render(<I18nProvider><IPStatusCard /></I18nProvider>) }

beforeEach(() => { window.localStorage.setItem('redlog-locale', 'en') })
afterEach(() => { cleanup(); window.localStorage.clear() })

it('lists detected nodes with tool, address, route and last seen, with no arrows and no health claim', async () => {
  install({ list: two }); mount()
  const nodes = await screen.findAllByTestId('pivot-node')
  expect(nodes).toHaveLength(2)
  expect(nodes[0].textContent).toContain('ligolo-ng')
  expect(nodes[0].textContent).toContain('192.0.2.24:11601')
  expect(nodes[0].textContent).toContain('route 172.16.10.0/24')
  expect(nodes[1].textContent).not.toContain('route')
  const block = screen.getByTestId('pivot-nodes').textContent ?? ''
  expect(block).toContain('2 relay node(s) detected')
  expect(block).toContain('not checked')
  expect(screen.getByTestId('ip-status-card').textContent).not.toMatch(/→|healthy|active tunnel/i)
})

it('still lists the nodes when the IP read failed', async () => {
  install({ ip: 'fail', list: two }); mount()
  expect(await screen.findByText('Could not read the IP status.')).toBeTruthy()
  expect(await screen.findAllByTestId('pivot-node')).toHaveLength(2)
})

it('shows nothing about relays when there are none', async () => {
  install({ list: [] }); mount()
  await screen.findByText('203.0.113.18')
  expect(screen.queryByTestId('pivot-nodes')).toBeNull()
  expect(screen.queryByTestId('pivot-error')).toBeNull()
})

it('says a failed pivot read is a failed read, not "none", and retries', async () => {
  install({ pivots: 'fail' }); mount()
  const err = await screen.findByTestId('pivot-error')
  expect(err.textContent).toContain('Could not read relay nodes')
  expect(screen.queryByTestId('pivot-nodes')).toBeNull()
  install({ list: two })
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findAllByTestId('pivot-node')).toHaveLength(2)
  expect(screen.queryByTestId('pivot-error')).toBeNull()
})

it('follows pushed changes', async () => {
  install({ list: [] }); mount()
  await screen.findByText('203.0.113.18')
  await waitFor(() => expect(typeof change).toBe('function'))
  act(() => change(two))
  expect(await screen.findAllByTestId('pivot-node')).toHaveLength(2)
})

it('treats an answer that is not a list as a failed read, not as none', async () => {
  install({ list: [] })
  ;(window as unknown as { redlog: { pivots: { getActive: () => Promise<unknown> } } }).redlog.pivots.getActive = async () => undefined
  mount()
  expect(await screen.findByTestId('pivot-error')).toBeTruthy()
})
