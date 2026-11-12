import { toast } from '../components/Toast'

/** Bursts of unhandled rejections show one toast per this window. */
export const REJECTION_TOAST_MS = 2000

/**
 * The safety net under every write that has no failure path of its own: a
 * promise rejection nobody handled shows one generic error toast instead of
 * failing silently. Only `unhandledrejection` is listened to, so a rejection
 * someone caught never reaches it. `preventDefault()` is deliberately not
 * called, so the browser still logs the rejection with its stack in devtools.
 * A burst (a failing loop, several writes failing together) shows one toast
 * per REJECTION_TOAST_MS, and the toast's merge key folds repeats into one.
 *
 * This is the last resort, not the failure handling: a write the operator
 * started should still say what failed through `runMutation`.
 */
export function installRejectionToast(message: () => string): () => void {
  let last = -Infinity
  const onRejection = (event: Event): void => {
    const now = Date.now()
    if (now - last < REJECTION_TOAST_MS) return
    last = now
    const reason = (event as PromiseRejectionEvent).reason
    toast(message(), {
      type: 'error',
      key: 'unhandled-rejection',
      detail: reason instanceof Error ? reason.message : reason === undefined ? undefined : String(reason)
    })
  }
  window.addEventListener('unhandledrejection', onRejection)
  return () => window.removeEventListener('unhandledrejection', onRejection)
}
