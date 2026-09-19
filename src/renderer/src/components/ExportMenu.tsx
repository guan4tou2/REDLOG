import { useState, useRef, useEffect } from 'react'
import { Download, ChevronDown } from 'lucide-react'
import { useI18n } from '../i18n'
import { useFocusTrap } from '../lib/useFocusTrap'
import { toast } from './Toast'
import { useViewExport } from '../lib/exportScope'

// One export control (docs/UIUX-STANDARD.md §10).
//
// The evidence bundle stays at the bottom, separated — it is a signed forensic
// artifact with its own scope-masking checkbox (unchanged).

export interface ExportMenuProps {
  totalCount?: number
}

export function ExportMenu({ totalCount }: ExportMenuProps): JSX.Element {
  const { t } = useI18n()
  const viewExport = useViewExport()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [maskScope, setMaskScope] = useState(true)
  const panel = useRef<HTMLDivElement | null>(null)
  useFocusTrap(panel, open)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const run = async (label: string, fn: () => Promise<string | null>): Promise<void> => {
    setBusy(true)
    try {
      const path = await fn()
      if (path) toast(t('export.done', { label }), { type: 'success', why: path })
      else toast(t('export.failed', { label }), { type: 'error', why: t('toast.exportFailedWhy') })
    } catch (e) {
      toast(t('export.failed', { label }), {
        type: 'error',
        why: t('toast.exportFailedWhy'),
        detail: String((e as Error)?.message ?? e)
      })
    } finally {
      setBusy(false)
      setOpen(false)
    }
  }

  const empty = totalCount === 0

  const Option = ({ label, onPick, disabled: off }: {
    label: string; onPick: () => void; disabled?: boolean
  }): JSX.Element => (
    <button
      onClick={onPick}
      disabled={busy || off}
      className="w-full text-left px-3 py-2 hover:bg-redlog-elevated focus-visible:outline-none focus-visible:bg-redlog-elevated disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <span className="block text-xs text-redlog-text">{label}</span>
    </button>
  )

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t('export.title')}
        className="flex items-center gap-1 px-2 h-6 text-xs rounded bg-redlog-elevated text-redlog-text-dim hover:text-redlog-text hover:bg-redlog-elevated-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-accent/50"
      >
        <Download size={13} strokeWidth={1.5} aria-hidden />
        {t('export.title')}
        <ChevronDown size={12} strokeWidth={1.5} aria-hidden />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-[90]" onClick={() => setOpen(false)} />
          <div
            ref={panel}
            role="menu"
            aria-label={t('export.title')}
            className="absolute right-0 top-7 z-[91] w-[280px] bg-redlog-surface border border-redlog-border rounded-lg shadow-2xl overflow-hidden py-1"
          >
            {/* ── Format options ── */}
            {empty && (
              <p className="px-3 py-1 text-xs text-redlog-text-faint italic">{t('export.empty')}</p>
            )}
            {viewExport && (
              <Option
                label={viewExport.label}
                disabled={empty}
                onPick={() => void run(viewExport.label, () => viewExport.run())}
              />
            )}
            <Option
              label={t('export.all')}
              disabled={empty}
              onPick={() => void run(t('export.all'), () => window.redlog.data.exportJson())}
            />
            <Option
              label={t('export.ndjson')}
              disabled={empty}
              onPick={() => void run(t('export.ndjson'), () => {
                const api = window.redlog.data as { exportNdjson?: () => Promise<string | null> }
                return api.exportNdjson?.() ?? Promise.resolve(null)
              })}
            />

            <div className="border-t border-redlog-border my-1" />
            {/* ── Evidence bundle (separate — different semantics) ── */}
            <Option
              label={t('export.bundle')}
              disabled={empty}
              onPick={() => void (async () => {
                setBusy(true)
                try {
                  const api = window.redlog.data as { exportBundle?: (opts?: { maskOutOfScope?: boolean }) => Promise<{ ok: boolean; outDir?: string; manifest?: Record<string, unknown> }> }
                  if (!api.exportBundle) { setBusy(false); return }
                  const r = await api.exportBundle({ maskOutOfScope: maskScope })
                  if (r.ok && r.outDir) {
                    toast(t('export.done', { label: t('export.bundle') }), { type: 'success', why: r.outDir })
                  } else {
                    toast(t('export.failed', { label: t('export.bundle') }), { type: 'error', why: t('toast.exportFailedWhy') })
                  }
                } catch (e) {
                  toast(t('export.failed', { label: t('export.bundle') }), { type: 'error', why: t('toast.exportFailedWhy'), detail: String((e as Error)?.message ?? e) })
                } finally { setBusy(false); setOpen(false) }
              })()}
            />
            <label className="flex items-start gap-2 px-3 py-1.5 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={maskScope}
                onChange={(e) => setMaskScope(e.target.checked)}
                className="mt-0.5 accent-red-600"
              />
              <span className={maskScope ? 'text-redlog-text-dim' : 'text-amber-500'}>
                {maskScope ? t('export.maskScope') : t('export.maskScopeOff')}
              </span>
            </label>
          </div>
        </>
      )}
    </div>
  )
}
