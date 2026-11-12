// @vitest-environment jsdom
//
// A screenshot whose file is not there. Seen in the running app: the row said
// "Screenshot recorded" beside the image-unavailable placeholder, offered
// "Delete file", and after the irreversible confirm did nothing at all.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const toastSpy = vi.fn()
vi.mock('../src/renderer/src/components/Toast', async (orig) => ({
  ...(await orig<typeof import('../src/renderer/src/components/Toast')>()),
  toast: (...args: unknown[]) => toastSpy(...args)
}))
vi.mock('../src/renderer/src/components/ConfirmDialog', async (orig) => ({
  ...(await orig<typeof import('../src/renderer/src/components/ConfirmDialog')>()),
  confirm: vi.fn(async () => true)
}))

import { I18nProvider } from '../src/renderer/src/i18n'
import { ScreenshotsView } from '../src/renderer/src/components/ScreenshotsView'

const withPath = { id: 's1', timestamp: 1, agentType: 'screenshot', targetId: null, data: { filename: 's1.png', filePath: '/x/s1.png', trigger: 'manual', sha256: 'a'.repeat(64) } }
const noPath = { id: 's2', timestamp: 2, agentType: 'screenshot', targetId: null, data: { filename: 's2.png', trigger: 'manual', sha256: 'b'.repeat(64) } }

let deleteFile: ReturnType<typeof vi.fn>
function install(items: unknown[]): void {
  deleteFile = vi.fn(async () => ({ ok: false, error: "ENOENT: no such file or directory, unlink '/x/s1.png'" }))
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { queryScreenshotPage: vi.fn(async () => ({ items, hasMore: false, nextCursor: null })), onNewBatch: () => () => {} },
    screenshot: { deleteFile },
    artifacts: { reveal: vi.fn(async () => true) }
  }
}
const mount = (): void => { render(<I18nProvider><ScreenshotsView onNavigate={() => {}} /></I18nProvider>) }
beforeEach(() => { window.localStorage.clear(); window.localStorage.setItem('redlog-locale', 'en'); toastSpy.mockClear() })
afterEach(() => cleanup())

it('offers no file deletion and no "recorded" badge for a screenshot with no file path', async () => {
  install([noPath])
  mount()
  expect(await screen.findByTestId('screenshot-unreadable')).toBeTruthy()
  expect(screen.queryByTestId('screenshot-delete')).toBeNull()
  expect(screen.queryByText('Screenshot recorded')).toBeNull()
  // The event itself is still there: its hash can be copied.
  expect(screen.getByTestId('screenshot-copy-hash')).toBeTruthy()
})

it('drops the "recorded" badge once the image fails to load', async () => {
  install([withPath])
  mount()
  await screen.findByTestId('screenshot-list')
  await waitFor(() => expect(document.querySelectorAll('img').length).toBe(1))
  expect(screen.getByText('Screenshot recorded')).toBeTruthy()
  fireEvent.error(document.querySelector('img')!)
  expect(screen.queryByText('Screenshot recorded')).toBeNull()
  expect(screen.getByText('Image unavailable')).toBeTruthy()
})

it('says so with the error toast when a delete cannot proceed', async () => {
  install([withPath])
  mount()
  await screen.findByTestId('screenshot-list')
  await waitFor(() => expect(document.querySelectorAll('img').length).toBe(1))
  fireEvent.error(document.querySelector('img')!)
  fireEvent.click(screen.getByTestId('screenshot-delete'))
  await waitFor(() => expect(deleteFile).toHaveBeenCalled())
  await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('Could not delete the image file', expect.objectContaining({ type: 'error' })))
  expect(screen.queryByText('File deleted · event record kept')).toBeNull()
})
