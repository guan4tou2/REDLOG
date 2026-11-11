// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const toast = vi.fn()
vi.mock('../src/renderer/src/components/Toast', () => ({ toast: (...a: unknown[]) => toast(...a) }))

const { installRejectionToast, REJECTION_TOAST_MS } = await import('../src/renderer/src/lib/unhandledRejection')

function reject(reason: unknown): Event {
  const event = new Event('unhandledrejection', { cancelable: true })
  Object.assign(event, { reason })
  window.dispatchEvent(event)
  return event
}

let uninstall = (): void => {}
beforeEach(() => { toast.mockClear(); vi.useFakeTimers({ toFake: ['Date'] }); uninstall = installRejectionToast(() => 'failed') })
afterEach(() => { uninstall(); vi.useRealTimers() })

it('shows one error toast carrying the reason, and leaves the event for devtools', () => {
  const event = reject(new Error('disk full'))
  expect(toast).toHaveBeenCalledTimes(1)
  expect(toast).toHaveBeenCalledWith('failed', expect.objectContaining({ type: 'error', detail: 'disk full' }))
  expect(event.defaultPrevented).toBe(false)
})

it('shows at most one toast per window during a burst', () => {
  for (let i = 0; i < 10; i++) reject(new Error(String(i)))
  expect(toast).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(REJECTION_TOAST_MS)
  reject(new Error('later'))
  expect(toast).toHaveBeenCalledTimes(2)
})

it('ignores a handled rejection', async () => {
  vi.useRealTimers()
  await Promise.reject(new Error('caught')).catch(() => {})
  await new Promise((r) => setTimeout(r, 20))
  expect(toast).not.toHaveBeenCalled()
})

it('stops listening once uninstalled', () => {
  uninstall()
  reject(new Error('x'))
  expect(toast).not.toHaveBeenCalled()
})
