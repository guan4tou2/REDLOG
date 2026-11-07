// @vitest-environment jsdom
//
// Stitch 03: loot names its types and confidence in words, screenshots say how
// many are shown and name the file a delete is about, and a bookmark needs a
// title, says what is optional, and keeps the draft when saving fails.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { LootPanel } from '../src/renderer/src/components/LootPanel'
import { ScreenshotsView } from '../src/renderer/src/components/ScreenshotsView'
import { BookmarksView } from '../src/renderer/src/components/BookmarksView'

const confirmSpy = vi.hoisted(() => vi.fn(async () => false))
const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('../src/renderer/src/components/ConfirmDialog', async (orig) => ({
  ...(await orig<typeof import('../src/renderer/src/components/ConfirmDialog')>()), confirm: confirmSpy
}))
vi.mock('../src/renderer/src/components/Toast', async (orig) => ({
  ...(await orig<typeof import('../src/renderer/src/components/Toast')>()), toast: toastSpy
}))

const w = (): { redlog: Record<string, any> } => window as unknown as { redlog: Record<string, any> }

beforeEach(() => { window.localStorage.clear(); window.localStorage.setItem('redlog-locale', 'en'); confirmSpy.mockClear(); toastSpy.mockClear() })
afterEach(() => cleanup())

describe('loot', () => {
  const loot = (id: string, type: string, confidence: string, ts: number) => ({
    id, timestamp: ts, agentType: 'loot', targetId: '10.0.0.5',
    data: { source: 'shell', matches: [{ type, confidence, preview: `p-${id}` }] }
  })
  const mount = (items: unknown[]): void => {
    w().redlog = { events: { queryPage: vi.fn(async () => ({ items, hasMore: false, nextCursor: null })), onNewBatch: () => () => {} } }
    render(<I18nProvider><LootPanel /></I18nProvider>)
  }

  it('names a type and its confidence in words', async () => {
    mount([loot('a', 'ntlm_hash', 'high', 2), loot('b', 'jwt', 'medium', 1)])
    await screen.findByText('p-a')
    expect(screen.getAllByText('NTLM hash').length).toBeGreaterThan(0)
    expect(screen.getByText('High confidence')).toBeTruthy()
    expect(screen.getByText('Medium confidence')).toBeTruthy()
  })

  it('keeps the stored name for a type this build has no word for', async () => {
    mount([loot('a', 'plugin_made_up', 'high', 2)])
    await screen.findByText('p-a')
    expect(screen.getAllByText('plugin made up').length).toBeGreaterThan(0)
  })
})

describe('screenshots', () => {
  const shot = (id: string, trigger: string) => ({
    id, timestamp: 1_000_000 + Number(id.replace(/\D/g, '')), agentType: 'screenshot', targetId: null,
    data: { filename: `${id}.png`, filePath: `/x/${id}.png`, trigger, sha256: `sha-${id}`.padEnd(64, '0') }
  })
  const install = (hasMore = false): void => {
    const items = [shot('s1', 'manual'), shot('s2', 'periodic')]
    w().redlog = {
      events: { queryScreenshotPage: vi.fn(async () => ({ items, hasMore, nextCursor: hasMore ? 'n' : null })), onNewBatch: () => () => {} },
      screenshot: { deleteFile: vi.fn(async () => ({ ok: true })) }, artifacts: { reveal: vi.fn(async () => true) }
    }
    render(<I18nProvider><ScreenshotsView onNavigate={() => {}} /></I18nProvider>)
  }

  it('says how many are shown, newest first', async () => {
    install()
    expect((await screen.findByTestId('screenshots-summary')).textContent).toBe('Showing 2 of 2 · newest first')
  })

  it('does not pass a partial page off as the whole: it says more is available', async () => {
    install(true)
    expect((await screen.findByTestId('screenshots-summary')).textContent).toBe('2 loaded, more available · newest first')
  })

  it('names the file a delete is about', async () => {
    install()
    fireEvent.click((await screen.findAllByTestId('screenshot-delete'))[0])
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled())
    const message = (confirmSpy.mock.calls[0] as unknown as string[])[1]
    expect(message).toMatch(/s[12]\.png/)
    expect(message).not.toContain('system.screenshot_deleted')
  })
})

describe('bookmark form', () => {
  const open = async (create: () => Promise<unknown>): Promise<void> => {
    w().redlog = {
      bookmarks: { list: async () => [], get: async () => null, create, update: async () => null, delete: async () => true },
      cdp: { getTab: async () => ({ url: null, title: null, connected: false }) }, app: { openExternal: async () => {} }
    }
    render(<I18nProvider><BookmarksView /></I18nProvider>)
    fireEvent.click(await screen.findByRole('button', { name: 'Quick Capture' }))
    await screen.findByRole('textbox', { name: /Title/i })
  }

  it('cannot be saved without a title, and marks the other two fields optional', async () => {
    await open(async () => null)
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('textbox', { name: 'URL (optional)' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Note (optional)' })).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: /Title/i }), { target: { value: 'Login page' } })
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('says so and keeps what was typed when saving fails', async () => {
    const create = vi.fn(async () => { throw new Error('disk full') })
    await open(create)
    fireEvent.change(screen.getByRole('textbox', { name: /Title/i }), { target: { value: 'Login page' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(toastSpy.mock.calls[0][0]).toBe('The bookmark was not saved')
    expect(toastSpy.mock.calls[0][1]).toMatchObject({ type: 'error', detail: 'disk full' })
    expect((screen.getByRole('textbox', { name: /Title/i }) as HTMLInputElement).value).toBe('Login page')
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Login page' }))
  })
})
