import { useState, useEffect, useCallback, useRef } from 'react'
import { useI18n } from '../i18n'
import { useFocusTrap } from '../lib/useFocusTrap'

// Confirmation, graded by consequence (docs/UIUX-STANDARD.md §5.5).
//
// One dialog for everything means the friction is identical whether the
// operator is clearing a filter or breaking an evidence chain, so it stops
// being read — and the one time it mattered, it had already been trained away.
// Three levels, and the difference between them is what the operator has to do
// with their hands:
//
//   plain         Enter confirms. For anything recoverable.
//   irreversible  a checkbox has to be ticked first. It cannot be dismissed by
//                 reflex, because reflex does not tick boxes.
//   chain         the project name has to be typed, and the concrete
//                 consequences are listed above the field. Reserved for
//                 anything touching the hash chain or the audit record.
//
// Level `plain` is also what the old two-argument `confirm()` produces, so
// existing call sites keep working and get graded deliberately rather than
// by a sweep.

export type ConfirmLevel = 'plain' | 'irreversible' | 'chain'

export interface ConfirmOpts {
  title: string
  message: string
  level?: ConfirmLevel
  confirmLabel?: string
  /** Concrete, itemised outcomes. §5.5: name what goes and what stays. */
  consequences?: string[]
  /** `chain` level: the exact string the operator has to type. */
  requireTyped?: string
  /** `irreversible` level: label for the acknowledgement checkbox. */
  ackLabel?: string
}

type ConfirmFn = (opts: ConfirmOpts) => Promise<boolean>
let _showConfirm: ConfirmFn = () => Promise.resolve(false)

/** Recoverable, or at least cheap to redo. Enter confirms. */
export function confirm(title: string, message: string, destructive = false): Promise<boolean> {
  return _showConfirm({ title, message, level: destructive ? 'irreversible' : 'plain' })
}

/** Cannot be undone, but does not touch the chain. Gated by a checkbox. */
export function confirmIrreversible(opts: Omit<ConfirmOpts, 'level'>): Promise<boolean> {
  return _showConfirm({ ...opts, level: 'irreversible' })
}

/** Touches the evidence chain or the audit record. Gated by typing the
 *  project name, with the consequences listed. */
export function confirmChainImpact(opts: Omit<ConfirmOpts, 'level'>): Promise<boolean> {
  return _showConfirm({ ...opts, level: 'chain' })
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

  if (!state) return null

  const close = (result: boolean): void => {
    state.resolve(result)
    setState(null)
  }

  return <ConfirmDialogInner key={state.title + state.message} state={state} close={close} t={t} />
}

function ConfirmDialogInner({ state, close, t }: {
  state: ConfirmOpts & { resolve: (v: boolean) => void }
  close: (result: boolean) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element {
  const level: ConfirmLevel = state.level ?? 'plain'
  const dialog = useRef<HTMLDivElement | null>(null)
  const confirmBtn = useRef<HTMLButtonElement | null>(null)
  const typedField = useRef<HTMLInputElement | null>(null)
  const ackBox = useRef<HTMLInputElement | null>(null)
  const [acked, setAcked] = useState(false)
  const [typed, setTyped] = useState('')

  // Armed = the operator has done the thing this level asks of them. Until
  // then the confirm button is genuinely disabled, not just styled as such,
  // and Enter does nothing.
  const armed =
    level === 'plain' ? true
      : level === 'irreversible' ? acked
        : typed.trim() === (state.requireTyped ?? '').trim() && typed.trim() !== ''

  // Focus lands on the gate rather than the confirm button at the two graded
  // levels: putting it on a disabled button says "you are done here" to a
  // keyboard user at the exact moment they are not. Worse than misleading —
  // a disabled button cannot take focus at all, so `irreversible` left focus
  // outside the dialog entirely, which is the exact failure the trap exists to
  // prevent. The comment said this before the code did.
  const initialFocus = level === 'chain' ? typedField : level === 'irreversible' ? ackBox : confirmBtn
  useFocusTrap(dialog, true, initialFocus)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); close(false) }
      // Enter only confirms once armed, and never from inside the typed field
      // while it is still wrong — otherwise the gate is one keystroke of
      // muscle memory away from not existing.
      if (e.key === 'Enter' && armed) { e.preventDefault(); close(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [armed, close])

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm select-text"
      onClick={() => close(false)}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={state.title}
        tabIndex={-1}
        className="bg-redlog-surface border border-redlog-border rounded-xl p-5 shadow-2xl max-w-sm w-full mx-4 animate-toast-in outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-redlog-text">{state.title}</h3>
        <p className="text-xs text-redlog-text-dim mt-2 leading-relaxed">{state.message}</p>

        {state.consequences && state.consequences.length > 0 && (
          <ul className="mt-3 space-y-1">
            {state.consequences.map((c) => (
              <li key={c} className="flex gap-2 text-xs text-redlog-text-dim leading-relaxed">
                <span className="text-redlog-danger shrink-0" aria-hidden>•</span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        )}

        {level === 'irreversible' && (
          <label className="mt-4 flex items-start gap-2 text-xs text-redlog-text cursor-pointer">
            <input
              ref={ackBox}
              type="checkbox"
              checked={acked}
              onChange={(e) => setAcked(e.target.checked)}
              className="mt-0.5 accent-redlog-danger"
            />
            <span>{state.ackLabel ?? t('confirm.ackDefault')}</span>
          </label>
        )}

        {level === 'chain' && (
          <div className="mt-4">
            <label htmlFor="confirm-typed" className="block text-xs text-redlog-text-dim mb-1">
              {t('confirm.typeToConfirm', { value: state.requireTyped ?? '' })}
            </label>
            <input
              id="confirm-typed"
              ref={typedField}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="w-full px-2 py-1.5 bg-redlog-elevated border border-redlog-border rounded text-xs font-mono text-redlog-text focus:border-redlog-danger outline-none"
            />
          </div>
        )}

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={() => close(false)}
            className="px-3 py-1.5 text-xs rounded-md bg-redlog-elevated text-redlog-text-dim hover:bg-redlog-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-redlog-text-dim transition-colors"
          >
            {t('confirm.cancel')}
          </button>
          <button
            ref={confirmBtn}
            onClick={() => close(true)}
            disabled={!armed}
            className={`px-3 py-1.5 text-xs rounded-md font-medium focus-visible:outline-none focus-visible:ring-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              level === 'plain'
                ? 'bg-redlog-elevated-hover text-redlog-text focus-visible:ring-redlog-text-dim'
                : 'bg-redlog-danger text-redlog-on-danger hover:bg-redlog-danger-hover focus-visible:ring-redlog-danger'
            }`}
          >
            {state.confirmLabel || (level === 'plain' ? t('confirm.confirm') : t('confirm.delete'))}
          </button>
        </div>
      </div>
    </div>
  )
}
