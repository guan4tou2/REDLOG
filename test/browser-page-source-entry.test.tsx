// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import BrowserPage from '../src/renderer/src/components/settings/BrowserPage'
vi.mock('../src/renderer/src/components/settings/BrowserPanel', () => ({ default: () => <div>web-capture-settings</div> }))
vi.mock('../src/renderer/src/components/HttpCaptureStep', () => ({ HttpCaptureStep: () => <div>https-verification-flow</div> }))
afterEach(cleanup)
it('offers HTTPS verification as a visible button that opens the verification flow', async () => {
  ;(window as any).redlog = { hooks: { detect: vi.fn().mockResolvedValue([]) } }
  render(<BrowserPage config={{} as any} setConfig={vi.fn()} t={key => key} />)
  const button = screen.getByRole('button', { name: 'firstRun.http.verifySettings' })
  expect(button.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(button)
  expect(screen.getByText('https-verification-flow')).toBeTruthy()
  expect(button.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(button)
  expect(screen.queryByText('https-verification-flow')).toBeNull()
})
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

it('retries a disconnected and a rejected check before showing the current tab result', async () => {
  const getTab = vi.fn().mockResolvedValueOnce({connected:false}).mockRejectedValueOnce(Error('bridge offline')).mockResolvedValueOnce({connected:true, title:'Test tab'})
  Object.assign(window,{redlog:{hooks:{detect:async()=>[]},cdp:{setPort:vi.fn(),getTab}}})
  render(<BrowserPage config={{} as any} setConfig={vi.fn()} t={key=>key} />)
  fireEvent.click(screen.getByRole('button',{name:'settings.testConnection'}))
  await screen.findByText('settings.cdpNotConnected')
  fireEvent.click(screen.getByRole('button',{name:'settings.cdpRetry'}))
  await screen.findByText('bridge offline')
  fireEvent.click(screen.getByRole('button',{name:'settings.cdpRetry'}))
  await screen.findByText('settings.cdpConnected')
  expect(screen.queryByRole('alert')).toBeNull()
})
it('times out an unanswered check and ignores its late result after recovery', async () => {
  vi.useFakeTimers()
  try {
    let finish!: (value: {connected:boolean}) => void
    const getTab = vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve})).mockResolvedValue({connected:true})
    Object.assign(window,{redlog:{hooks:{detect:async()=>[]},cdp:{setPort:vi.fn(),getTab}}})
    render(<BrowserPage config={{} as any} setConfig={vi.fn()} t={key=>key} />)
    fireEvent.click(screen.getByRole('button',{name:'settings.testConnection'}))
    expect((screen.getByRole('button',{name:'common.loading'}) as HTMLButtonElement).disabled).toBe(true)
    await act(async()=>{await vi.advanceTimersByTimeAsync(10000)})
    expect(screen.getByText('settings.cdpTimeout')).toBeTruthy()
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'settings.cdpRetry'})))
    await act(async()=>finish({connected:false}))
    expect(screen.getByText('settings.cdpConnected')).toBeTruthy()
  } finally { vi.useRealTimers() }
})
