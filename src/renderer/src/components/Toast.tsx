import { useState, useEffect, useCallback } from 'react'

interface ToastData {
  id: number
  message: string
  type: 'success' | 'error' | 'info' | 'warning'
  createdAt: number
}

type ToastFn = (message: string, type?: ToastData['type']) => void
let _pushToast: ToastFn = () => {}

export function toast(message: string, type: ToastData['type'] = 'info'): void {
  _pushToast(message, type)
}

const TYPE_STYLES: Record<string, string> = {
  success: 'border-emerald-500/30 bg-emerald-950/80 text-emerald-300',
  error: 'border-red-500/30 bg-red-950/80 text-red-300',
  info: 'border-zinc-600/30 bg-zinc-900/90 text-zinc-300',
  warning: 'border-amber-500/30 bg-amber-950/80 text-amber-300'
}

const TYPE_ICONS: Record<string, string> = {
  success: '✓',
  error: '✕',
  info: 'ℹ',
  warning: '⚠'
}

export function ToastContainer(): JSX.Element | null {
  const [toasts, setToasts] = useState<ToastData[]>([])

  const push = useCallback<ToastFn>((message, type = 'info') => {
    setToasts((prev) => [...prev, { id: Date.now() + Math.random(), message, type, createdAt: Date.now() }])
  }, [])

  useEffect(() => {
    _pushToast = push
    return (): void => { _pushToast = () => {} }
  }, [push])

  // Each toast expires on its own 3s clock (audit finding P0 #6): the prior
  // effect used a single shared timer keyed on `toasts`, so every new push
  // reset the 3s window for the OLDEST toast — bursts of toasts extended each
  // other indefinitely. Prune by age on a steady interval instead.
  useEffect(() => {
    if (toasts.length === 0) return
    const tick = (): void => {
      const cutoff = Date.now() - 3000
      setToasts((prev) => prev.filter((t) => t.createdAt > cutoff))
    }
    const iv = setInterval(tick, 500)
    return () => clearInterval(iv)
  }, [toasts.length === 0])

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-12 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-center gap-2.5 px-4 py-2.5 rounded-lg border backdrop-blur-md text-xs font-medium shadow-lg animate-toast-in pointer-events-auto ${TYPE_STYLES[t.type]}`}
        >
          <span className="text-[11px] opacity-70">{TYPE_ICONS[t.type]}</span>
          {t.message}
        </div>
      ))}
    </div>
  )
}
