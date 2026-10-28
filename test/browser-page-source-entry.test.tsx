// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import BrowserPage from '../src/renderer/src/components/settings/BrowserPage'
vi.mock('../src/renderer/src/components/settings/BrowserPanel', () => ({ default: () => <div>web-capture-settings</div> }))
afterEach(cleanup)
it('keeps optional proxy setup and removal beside web capture', async () => {
  ;(window as any).redlog = { hooks: { detect: vi.fn().mockResolvedValue([
    { id: 'mitmproxy', manualSteps: [{ label: 'DNS setup', command: 'synthetic-dns-setup' }], removalSteps: [{ label: 'DNS removal', command: 'synthetic-dns-removal' }] }
  ]) } }
  render(<BrowserPage config={{} as any} setConfig={vi.fn()} t={key => key} />)
  const summary = await screen.findByText('settings.hookOptionalSteps')
  fireEvent.click(summary)
  expect(screen.getByText('DNS setup')).toBeTruthy()
  fireEvent.click(screen.getByTestId('teardown-toggle'))
  expect(screen.getByText('DNS removal')).toBeTruthy()
  expect(screen.getByText('web-capture-settings')).toBeTruthy()
})

it('keeps web settings available after a source read failure and retries without installing', async () => {
  const detect = vi.fn().mockRejectedValueOnce(new Error('source unavailable')).mockResolvedValue([])
  const install = vi.fn()
  ;(window as any).redlog = { hooks: { detect, install } }
  render(<BrowserPage config={{} as any} setConfig={vi.fn()} t={key => key} />)
  expect((await screen.findByRole('alert')).textContent).toContain('source unavailable')
  expect(screen.getByText('web-capture-settings')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'common.retry' }))
  await screen.findByText('web-capture-settings')
  await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  expect(detect).toHaveBeenCalledTimes(2)
  expect(install).not.toHaveBeenCalled()
  expect(screen.queryByText('settings.hookOptionalSteps')).toBeNull()
})
