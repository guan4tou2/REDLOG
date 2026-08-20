import { useState, useEffect, useCallback, useRef } from 'react'
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

  return <ConfirmDialogInner state={state} close={close} t={t} />
}

function ConfirmDialogInner({ state, close, t }: {
  state: ConfirmOpts & { resolve: (v: boolean) => void }
  close: (result: boolean) => void
  t: (key: string) => string
}): JSX.Element {
  // Autofocus the confirm button so keyboard users have a visible focus target
  // (audit finding P1 #31 — the dialog had no focus at all before).
  const confirmBtn = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { confirmBtn.current?.focus() }, [])
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm select-text" onClick={() => close(false)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={state.title}
        className="bg-redlog-surface border border-redlog-border rounded-xl p-5 shadow-2xl max-w-sm w-full mx-4 animate-toast-in outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-redlog-text">{state.title}</h3>
        <p className="text-xs text-redlog-text-dim mt-2 leading-relaxed">{state.message}</p>
        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={() => close(false)}
            className="px-3 py-1.5 text-xs rounded-md bg-redlog-elevated text-redlog-text-dim hover:bg-redlog-elevated-hover focus:outline-none focus:ring-2 focus:ring-redlog-text-dim transition-colors"
          >
            {t('confirm.cancel')}
          </button>
          <button
            ref={confirmBtn}
            onClick={() => close(true)}
            className={`px-3 py-1.5 text-xs rounded-md font-medium focus:outline-none focus:ring-2 transition-colors ${
              state.destructive
                ? 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-400'
                : 'bg-redlog-elevated-hover text-redlog-text hover:bg-redlog-elevated-hover focus:ring-redlog-text-dim'
            }`}
          >
            {state.confirmLabel || (state.destructive ? t('confirm.delete') : t('confirm.confirm'))}
          </button>
        </div>
      </div>
    </div>
  )
}
