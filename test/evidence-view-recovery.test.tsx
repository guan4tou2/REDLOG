// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ScreenshotsView } from '../src/renderer/src/components/ScreenshotsView'
import { TargetView } from '../src/renderer/src/components/TargetView'
import { I18nProvider } from '../src/renderer/src/i18n'
import { installTimelineBridge, makeEvent, page, deferred } from './helpers/timeline-bridge'

beforeEach(() => { installTimelineBridge() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('screenshot initial failure offers a retry rather than spinning forever', async () => {
  const query = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(page([]))
  Object.assign(window.redlog.events, { queryScreenshotPage: query })
  render(<I18nProvider><ScreenshotsView onNavigate={() => {}} /></I18nProvider>)
  expect(await screen.findByTestId('screenshots-load-failed')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Retry/ }))
  await waitFor(() => expect(screen.queryByTestId('screenshots-load-failed')).toBeNull())
  expect(query).toHaveBeenCalledTimes(2)
})

it('target list failures are retryable', async () => {
  vi.spyOn(window.redlog.events, 'aggregateTargets').mockRejectedValueOnce(new Error('offline')).mockResolvedValue([])
  render(<I18nProvider><TargetView /></I18nProvider>)
  expect(await screen.findByTestId('targets-load-failed')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Retry/ }))
  await waitFor(() => expect(screen.queryByTestId('targets-load-failed')).toBeNull())
})

it('a late target response cannot replace evidence for the newly selected target', async () => {
  vi.spyOn(window.redlog.events, 'aggregateTargets').mockResolvedValue(
    ['10.0.0.1', '10.0.0.2'].map(target => ({ target, firstSeen: 1, lastSeen: 2, eventCount: 1 }))
  )
  const old = deferred<ReturnType<typeof page>>()
  const query = vi.spyOn(window.redlog.events, 'queryPage')
    .mockImplementationOnce(() => old.promise as any)
    .mockResolvedValueOnce(page([makeEvent('new', 2, 'shell', { data: { command: 'new-target-command' } })]) as any)
  render(<I18nProvider><TargetView /></I18nProvider>)
  fireEvent.click(await screen.findByText('10.0.0.1'))
  fireEvent.click(screen.getByText('10.0.0.2'))
  expect(await screen.findByText('new-target-command')).not.toBeNull()
  await act(async () => old.resolve(page([makeEvent('old', 1, 'shell', { data: { command: 'old-target-command' } })])))
  expect(screen.queryByText('old-target-command')).toBeNull()
  expect(screen.getByText('new-target-command')).not.toBeNull()
  expect(query).toHaveBeenCalledTimes(2)
})
