// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import PluginsPanel from '../src/renderer/src/components/settings/PluginsPanel'
import en from '../src/renderer/src/i18n/en.json'

// #347: what the page shows must be what main has done. Disabling used to be
// drawn at once and written eight seconds later, with one toast that said both.

const toasts = vi.hoisted(() => ({
  plain: [] as Array<{ message: string; opts: unknown }>,
  undo: [] as Array<{ message: string; onUndo: () => void; opts: unknown }>
}))
vi.mock('../src/renderer/src/components/Toast', () => ({
  toast: (message: string, opts: unknown) => { toasts.plain.push({ message, opts }) },
  toastUndo: (message: string, onUndo: () => void, opts: unknown) => { toasts.undo.push({ message, onUndo, opts }) }
}))

const t = (key: string, vars?: Record<string, string | number>): string =>
  ((en as Record<string, string>)[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars?.[k] ?? ''))

type Status = 'active' | 'disabled'
const view = (id: string, status: Status = 'active') => ({
  id, name: `Plugin ${id}`, version: '1.0.0', description: '', author: 'x', source: 'user' as const,
  tier: 'declarative' as const, status, capabilities: [], contributes: []
})

const api = {
  list: vi.fn(), reload: vi.fn(), openFolder: vi.fn(), setEnabled: vi.fn(), grant: vi.fn(), revoke: vi.fn()
}
const draw = (): void => {
  ;(window as unknown as { redlog: unknown }).redlog = { plugins: api }
  render(<PluginsPanel t={t} />)
}
const deferred = <T,>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('the plugins page shows what main has done', () => {
  beforeEach(() => {
    toasts.plain.length = 0; toasts.undo.length = 0
    Object.values(api).forEach((f) => f.mockReset())
  })
  afterEach(() => cleanup())

  it('writes a disable at once, and calls it disabled only after main says so', async () => {
    const wait = deferred<ReturnType<typeof view>[]>()
    api.list.mockResolvedValue([view('a')])
    api.setEnabled.mockReturnValue(wait.promise)
    draw()
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }))
    // Written now, not after a timer…
    expect(api.setEnabled).toHaveBeenCalledWith('a', false)
    // …and not yet drawn as disabled, because main has not answered.
    expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull()
    expect(toasts.undo).toHaveLength(0)
    await act(async () => { wait.resolve([view('a', 'disabled')]) })
    expect(await screen.findByRole('button', { name: 'Enable' })).toBeTruthy()
    expect(toasts.undo).toHaveLength(1)
  })

  it('says what a disable does and does not do, and that it is global', async () => {
    api.list.mockResolvedValue([view('a')])
    api.setEnabled.mockResolvedValue([view('a', 'disabled')])
    draw()
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }))
    await waitFor(() => expect(toasts.undo).toHaveLength(1))
    const why = JSON.stringify(toasts.undo[0].opts)
    expect(why).toContain('every project')
    expect(why).toContain('does not remove shell hooks')
    expect(why).not.toMatch(/Not written yet|8 seconds/)
    expect(screen.getByTestId('plugins-global-note').textContent).toContain('every project')
  })

  it('makes Undo an explicit re-enable', async () => {
    api.list.mockResolvedValue([view('a')])
    api.setEnabled.mockResolvedValueOnce([view('a', 'disabled')]).mockResolvedValueOnce([view('a', 'active')])
    draw()
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }))
    await waitFor(() => expect(toasts.undo).toHaveLength(1))
    await act(async () => { toasts.undo[0].onUndo() })
    expect(api.setEnabled).toHaveBeenLastCalledWith('a', true)
    expect(await screen.findByRole('button', { name: 'Disable' })).toBeTruthy()
  })

  it('does not leave a switch drawn as flipped when main refuses, and reads the real list back', async () => {
    api.list.mockResolvedValue([view('a')])
    api.setEnabled.mockRejectedValue(new Error('state.json is read-only'))
    draw()
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }))
    await waitFor(() => expect(toasts.plain).toHaveLength(1))
    expect(toasts.plain[0].message).toBe('Could not disable Plugin a')
    expect(JSON.stringify(toasts.plain[0].opts)).toContain('state.json is read-only')
    expect(toasts.undo).toHaveLength(0)
    // Read back, and still enabled — the button is usable again.
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2))
    const again = await screen.findByRole('button', { name: 'Disable' }) as HTMLButtonElement
    expect(again.disabled).toBe(false)
  })

  it('keeps a rejected reload from leaving the page busy', async () => {
    api.list.mockResolvedValue([view('a')])
    api.reload.mockRejectedValue(new Error('ipc closed'))
    draw()
    await screen.findByRole('button', { name: 'Disable' })
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(toasts.plain.some((x) => x.message === 'Could not reload plugins')).toBe(true))
    expect((screen.getByRole('button', { name: 'Reload' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('says a list that failed to load is not an empty list, and retries', async () => {
    api.list.mockRejectedValueOnce(new Error('main not ready')).mockResolvedValueOnce([view('a')])
    draw()
    const alert = await screen.findByTestId('plugins-load-error')
    expect(alert.textContent).toContain('main not ready')
    expect(alert.textContent).toContain('does not mean there are none')
    expect(screen.queryByText(/No plugins found/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('button', { name: 'Disable' })).toBeTruthy()
    expect(screen.queryByTestId('plugins-load-error')).toBeNull()
  })

  it('shows "no plugins" only when the list loaded and is empty', async () => {
    api.list.mockResolvedValue([])
    draw()
    expect(await screen.findByText(/No plugins found/)).toBeTruthy()
  })

  it('does not let a slow, older answer undo a newer decision', async () => {
    const slowReload = deferred<ReturnType<typeof view>[]>()
    api.list.mockResolvedValue([view('a')])
    api.reload.mockReturnValue(slowReload.promise)
    api.setEnabled.mockResolvedValue([view('a', 'disabled')])
    draw()
    await screen.findByRole('button', { name: 'Disable' })
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))          // starts first, answers last
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))         // decided after
    expect(await screen.findByRole('button', { name: 'Enable' })).toBeTruthy()
    // The reload finally answers with the list as it was before the disable.
    await act(async () => { slowReload.resolve([view('a', 'active')]) })
    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull()
  })
})
