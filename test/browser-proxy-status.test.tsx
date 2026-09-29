// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import BrowserPanel from '../src/renderer/src/components/settings/BrowserPanel'
import type { ConfigState } from '../src/renderer/src/components/settings/SettingsShared'
vi.mock('../src/renderer/src/components/Toast', () => ({ toast: vi.fn() }))
afterEach(cleanup)
function mount(status: ReturnType<typeof vi.fn>, start = vi.fn()) {
  Object.assign(window, { redlog: { browser: { detect: async () => null }, httpCapture: { status, start, stop: vi.fn() } } })
  return render(<BrowserPanel t={k => k} config={{} as ConfigState} setConfig={vi.fn()} />)
}
it('follows proxy state changed through another surface', async () => {
  let state = 'stopped'
  mount(vi.fn(async () => ({ state, url: null })))
  await screen.findByText('httpCapture.state.stopped')
  state = 'running'
  await waitFor(() => expect(screen.queryByText('httpCapture.state.running')).not.toBeNull(), { timeout: 4000 })
})
it('reports an unreadable status rather than stopped, and allows retry', async () => {
  mount(vi.fn().mockRejectedValueOnce(new Error('status unavailable')).mockResolvedValue({ state: 'stopped', url: null }))
  await screen.findByText('status unavailable')
  expect(screen.queryByText('httpCapture.state.stopped')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'common.retry' }))
  await screen.findByText('httpCapture.state.stopped')
})
it('finishes a rejected start and lets the operator recover', async () => {
  let state = 'stopped'
  const start = vi.fn().mockRejectedValueOnce(new Error('start unavailable')).mockImplementationOnce(async () => { state = 'running'; return { state, url: null } })
  mount(vi.fn(async () => ({ state, url: null })), start)
  fireEvent.click(await screen.findByRole('button', { name: 'httpCapture.start' }))
  await screen.findByText('start unavailable')
  fireEvent.click(screen.getByRole('button', { name: 'common.retry' }))
  fireEvent.click(await screen.findByRole('button', { name: 'httpCapture.start' }))
  await screen.findByText('httpCapture.state.running')
})
