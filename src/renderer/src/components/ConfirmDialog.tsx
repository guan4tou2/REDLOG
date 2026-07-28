import { useState, useEffect, useCallback } from 'react'
import { useI18n } from '../i18n'

interface ConfirmOpts {
  title: string
  message: string
  destructive?: boolean
  confirmLabel?: string
}

type ConfirmFn = (opts: ConfirmOpts) => Promise<boolean>
let _showConfirm: ConfirmFn = () => Promise.resolve(false)

export function confirm(title: string, message: string, destructive = false): Promise<boolean> {
  return _showConfirm({ title, message, destructive })
}

export function ConfirmDialogContainer(): JSX.Element | null {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null)
  const { t } = useI18n()

  const show = useCallback<ConfirmFn>((opts) => {
    return new Promise((resolve) => setState({ ...opts, resolve }))
  }, [])

  useEffect(() => {
    _showConfirm = show
    return (): void => { _showConfirm = () => Promise.resolve(false) }
  }, [show])

  useEffect(() => {
    if (!state) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { state.resolve(false); setState(null) }
      if (e.key === 'Enter') { state.resolve(true); setState(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state])

  if (!state) return null

  const close = (result: boolean): void => {
    state.resolve(result)
    setState(null)
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => close(false)}>
      <div
        className="bg-redlog-surface border border-redlog-border rounded-xl p-5 shadow-2xl max-w-sm w-full mx-4 animate-toast-in"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-zinc-200">{state.title}</h3>
        <p className="text-xs text-zinc-400 mt-2 leading-relaxed">{state.message}</p>
        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={() => close(false)}
            className="px-3 py-1.5 text-xs rounded-md bg-zinc-800 text-zinc-400 hover:bg-zinc-700 transition-colors"
          >
            {t('confirm.cancel')}
          </button>
          <button
            onClick={() => close(true)}
            className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
              state.destructive
                ? 'bg-red-600 text-white hover:bg-red-700'
                : 'bg-zinc-700 text-zinc-200 hover:bg-zinc-600'
            }`}
          >
            {state.confirmLabel || (state.destructive ? t('confirm.delete') : t('confirm.confirm'))}
          </button>
        </div>
      </div>
    </div>
  )
}
