import { useState, useEffect, useCallback, useRef } from 'react'
import { useI18n } from '../i18n'

// Toast, rebuilt against docs/UIUX-STANDARD.md §9.
//
// The old one had a single shape — a string and a colour — and a 3s clock that
// applied to all of them. That is fine for "saved" and actively harmful for
// "anchoring failed": the one message an operator must not miss was the one
// most likely to vanish while they were looking at another window. Four rules
// from §9, all of them about errors:
//
//   1. Errors do not auto-dismiss. Everything else still does.
//   2. Repeats merge into a count rather than stacking. A failing poll used to
//      be able to fill the screen with forty copies of itself.
//   3. At most three on screen. Past that the oldest goes, because a stack
//      taller than three is a wall, not a notification.
//   4. The container is a live region, and errors announce assertively.
//
// The payload gains the three-part error shape §9 asks for: what happened, why
// it happened, and one action — with the raw error behind a disclosure rather
// than in the headline, since `e.message` is written for whoever wrote the
// throw, not for the operator reading it at 2am.

export type ToastType = 'success' | 'error' | 'info' | 'warning'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastOptions {
  type?: ToastType
  /** Second line: why this happened, in the operator's language. */
  why?: string
  /** Exactly one action. More than one and it is a dialog, not a toast. */
  action?: ToastAction
  /** Raw error text, collapsed behind a disclosure. */
  detail?: string
  /** Merge key. Defaults to type + message, which is usually what you want. */
  key?: string
  /** Milliseconds on screen. Defaults to 3000, or never for errors. */
  duration?: number
}

interface ToastData extends ToastOptions {
  id: number
  message: string
  type: ToastType
  key: string
  count: number
  /** Epoch ms, or Infinity for a toast that waits to be dismissed. */
  expiresAt: number
}

const DEFAULT_MS = 3000
/** §10: long enough to notice and act, short enough not to hold up a queue. */
export const UNDO_MS = 8000
const MAX_VISIBLE = 3

type PushFn = (message: string, opts: ToastOptions) => void
let _push: PushFn = () => {}

export function toast(message: string, opts: ToastType | ToastOptions = {}): void {
  _push(message, typeof opts === 'string' ? { type: opts } : opts)
}

/** The action already happened and can be reversed. */
export function toastUndo(message: string, onUndo: () => void, opts: ToastOptions = {}): void {
  _push(message, { ...opts, duration: opts.duration ?? UNDO_MS, action: { label: '__undo__', onClick: onUndo } })
}

/** The action has NOT happened yet: `commit` runs when the window closes, and
 *  not at all if the operator takes it back. Use this where the side effect is
 *  the expensive part — §10 wants three config changes deferred this way so an
 *  undo inside the window never reaches the audit log at all. */
export function toastDeferred(
  message: string,
  commit: () => void,
  opts: ToastOptions & { revert?: () => void } = {}
): void {
  const ms = opts.duration ?? UNDO_MS
  let cancelled = false
  const timer = setTimeout(() => { if (!cancelled) commit() }, ms)
  _push(message, {
    ...opts,
    duration: ms,
    action: {
      label: '__undo__',
      onClick: () => {
        cancelled = true
        clearTimeout(timer)
        // The caller usually showed the change optimistically so the UI would
        // not sit still for eight seconds. `revert` puts that back.
        opts.revert?.()
      }
    }
  })
}

const TYPE_STYLES: Record<ToastType, string> = {
  success: 'border-emerald-500/30 bg-emerald-950/80 text-emerald-300',
  error: 'border-redlog-danger/40 bg-red-950/85 text-red-200',
  info: 'border-redlog-border bg-redlog-surface/95 text-redlog-text',
  warning: 'border-amber-500/30 bg-amber-950/80 text-amber-300'
}

const TYPE_ICONS: Record<ToastType, string> = {
  success: '✓', error: '✕', info: 'ℹ', warning: '⚠'
}

export function ToastContainer(): JSX.Element | null {
  const [toasts, setToasts] = useState<ToastData[]>([])
  const [expanded, setExpanded] = useState<number | null>(null)
  const seq = useRef(0)
  const { t } = useI18n()

  const push = useCallback<PushFn>((message, opts) => {
    const type = opts.type ?? 'info'
    // Errors wait to be dismissed. An operator who missed one cannot ask for
    // it back, and the failures that produce them — a broken chain, a failed
    // anchor — are exactly the ones that must not scroll past unseen.
    const duration = opts.duration ?? (type === 'error' ? Infinity : DEFAULT_MS)
    const key = opts.key ?? `${type}:${message}`
    setToasts((prev) => {
      const now = Date.now()
      const expiresAt = duration === Infinity ? Infinity : now + duration
      const at = prev.findIndex((x) => x.key === key)
      // Merge rather than stack: the same failure repeating is one fact with a
      // count, not N notifications.
      const next = at >= 0
        ? prev.map((x, i) => (i === at ? { ...x, ...opts, message, type, count: x.count + 1, expiresAt } : x))
        : [...prev, { ...opts, id: ++seq.current, message, type, key, count: 1, expiresAt }]
      return next.slice(-MAX_VISIBLE)
    })
  }, [])

  useEffect(() => {
    _push = push
    return (): void => { _push = () => {} }
  }, [push])

  // Prune by deadline on a steady interval. Each toast carries its own, so a
  // burst can never extend the oldest one's life (audit finding P0 #6).
  const live = toasts.length > 0
  useEffect(() => {
    if (!live) return
    const iv = setInterval(() => {
      const now = Date.now()
      setToasts((prev) => prev.filter((x) => x.expiresAt > now))
    }, 250)
    return () => clearInterval(iv)
  }, [live])

  if (toasts.length === 0) return null

  const dismiss = (id: number): void => setToasts((prev) => prev.filter((x) => x.id !== id))

  return (
    <div
      className="fixed bottom-12 right-4 z-[100] flex flex-col gap-2 pointer-events-none select-text max-w-[380px]"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((x) => (
        <div
          key={x.id}
          // Errors announce assertively; everything else rides the container's
          // polite region so a "saved" never interrupts what is being read.
          role={x.type === 'error' ? 'alert' : 'status'}
          className={`flex flex-col gap-1.5 px-4 py-2.5 rounded-lg border backdrop-blur-md text-xs shadow-lg animate-toast-in pointer-events-auto ${TYPE_STYLES[x.type]}`}
        >
          <div className="flex items-start gap-2.5">
            <span className="opacity-70 leading-5" aria-hidden>{TYPE_ICONS[x.type]}</span>
            <span className="font-medium leading-5 flex-1">
              {x.message}
              {x.count > 1 && (
                <span className="ml-1.5 opacity-70 tabular-nums font-normal">
                  {t('toast.repeat', { count: x.count })}
                </span>
              )}
            </span>
            <button
              onClick={() => dismiss(x.id)}
              className="-mr-1 opacity-50 hover:opacity-100 focus-visible:outline-none focus-visible:opacity-100 transition-opacity leading-5"
              aria-label={t('toast.dismiss')}
            >×</button>
          </div>

          {x.why && <p className="pl-[22px] opacity-80 leading-5 font-normal">{x.why}</p>}

          {(x.action || x.detail) && (
            <div className="pl-[22px] flex items-center gap-3">
              {x.action && (
                <button
                  onClick={() => { x.action?.onClick(); dismiss(x.id) }}
                  className="underline underline-offset-2 font-medium hover:no-underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current rounded"
                >
                  {x.action.label === '__undo__' ? t('toast.undo') : x.action.label}
                </button>
              )}
              {x.detail && (
                <button
                  onClick={() => setExpanded((e) => (e === x.id ? null : x.id))}
                  aria-expanded={expanded === x.id}
                  className="opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current rounded"
                >
                  {t('toast.details')}
                </button>
              )}
            </div>
          )}

          {x.detail && expanded === x.id && (
            <pre className="ml-[22px] mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-xs opacity-80 bg-black/30 rounded p-2">
              {x.detail}
            </pre>
          )}
        </div>
      ))}
    </div>
  )
}
