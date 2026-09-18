import { useState, useRef, useEffect } from 'react'
import { Download, ChevronDown } from 'lucide-react'
import { useI18n } from '../i18n'
import { useFocusTrap } from '../lib/useFocusTrap'
import { toast } from './Toast'
import { useViewExport } from '../lib/exportScope'

// One export control (docs/UIUX-STANDARD.md §10).
//
// Option D "soft presets": a segmented control answers "who is this for?"
// before the format. "For my records" = current behaviour (no extra masking).
// "For sharing" = metadata masking + operator PII scrub + operator-infra
// exclusion + out-of-scope row exclusion where the format supports it.
//
// The evidence bundle stays at the bottom, separated — it is a signed forensic
// artifact with its own scope-masking checkbox (unchanged).

export type ExportScope = 'all' | 'view' | 'slice'
export type ExportFormat = 'json' | 'markdown'

export interface ExportMenuProps {
  totalCount?: number
}

const BYTES_PER_EVENT = 520

function humanSize(events: number): string {
  const bytes = events * BYTES_PER_EVENT
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ExportMenu({ totalCount }: ExportMenuProps): JSX.Element {
  const { t } = useI18n()
  const viewExport = useViewExport()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [maskScope, setMaskScope] = useState(true)
  const panel = useRef<HTMLDivElement | null>(null)
  useFocusTrap(panel, open)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const sharingOpts = sharing ? { sharing: true as const } : undefined

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

  const Option = ({ label, count, onPick }: {
    label: string; count?: number; onPick: () => void
  }): JSX.Element => (
    <button
      onClick={onPick}
      disabled={busy}
      className="w-full text-left px-3 py-2 hover:bg-redlog-elevated focus-visible:outline-none focus-visible:bg-redlog-elevated disabled:opacity-40"
    >
      <span className="block text-xs text-redlog-text">{label}</span>
      {typeof count === 'number' && (
        <span className="block text-xs text-redlog-text-faint tabular-nums">
          {t('export.preview', { count, size: humanSize(count) })}
        </span>
      )}
    </button>
  )

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={t('export.title')}
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
            {/* ── Audience preset ── */}
            <div className="px-3 pt-1.5 pb-1">
              <div className="flex rounded border border-redlog-border overflow-hidden">
                <button
                  onClick={() => setSharing(false)}
                  className={`flex-1 py-1 text-xs text-center transition-colors ${
                    !sharing
                      ? 'bg-redlog-elevated text-redlog-text'
                      : 'bg-transparent text-redlog-text-dim hover:text-redlog-text'
                  }`}
                >{t('export.presetRecords')}</button>
                <button
                  onClick={() => setSharing(true)}
                  className={`flex-1 py-1 text-xs text-center border-l border-redlog-border transition-colors ${
                    sharing
                      ? 'bg-cyan-500/15 text-cyan-400'
                      : 'bg-transparent text-redlog-text-dim hover:text-redlog-text'
                  }`}
                >{t('export.presetSharing')}</button>
              </div>
              {sharing && (
                <p className="text-[10px] text-cyan-400/70 mt-1 leading-tight">
                  {t('export.sharingHint')}
                </p>
              )}
            </div>

            <div className="border-t border-redlog-border my-1" />

            {/* ── Format options ── */}
            {viewExport && (
              <Option
                label={viewExport.label}
                count={viewExport.count}
                onPick={() => void run(viewExport.label, () => viewExport.run(sharingOpts))}
              />
            )}
            <Option
              label={t('export.all')}
              count={totalCount}
              onPick={() => void run(t('export.all'), () => window.redlog.data.exportJson(sharingOpts))}
            />
            <Option
              label={t('export.ndjson')}
              onPick={() => void run(t('export.ndjson'), () => {
                const api = window.redlog.data as { exportNdjson?: (o?: { scopeOnly?: boolean; scrubPii?: boolean; sharing?: boolean }) => Promise<string | null> }
                return api.exportNdjson?.(sharingOpts) ?? Promise.resolve(null)
              })}
            />

            <div className="border-t border-redlog-border my-1" />
            {/* ── Evidence bundle (separate — different semantics) ── */}
            <Option
              label={t('export.bundle')}
              onPick={() => void (async () => {
                setBusy(true)
                try {
                  const api = window.redlog.data as { exportBundle?: (opts?: { maskOutOfScope?: boolean }) => Promise<{ ok: boolean; outDir?: string; manifest?: Record<string, unknown> }> }
                  if (!api.exportBundle) { setBusy(false); return }
                  const r = await api.exportBundle({ maskOutOfScope: maskScope })
                  if (r.ok && r.outDir) {
                    const m = r.manifest as {
                      tiers?: { chained?: number; logged?: number }
                      sanitizedOutOfScope?: number
                      attachmentScopePolicy?: { screenshots?: { included: number; excludedOutOfScope: number }; casts?: { included: number } }
                    } | undefined
                    const chained = m?.tiers?.chained ?? 0
                    const logged = m?.tiers?.logged ?? 0
                    const masked = m?.sanitizedOutOfScope ?? 0
                    const shots = m?.attachmentScopePolicy?.screenshots
                    const casts = m?.attachmentScopePolicy?.casts
                    const detail = [
                      t('export.bundleSummaryEvents', { chained, logged }),
                      masked > 0 ? t('export.bundleSummaryMasked', { count: masked }) : '',
                      shots ? t('export.bundleSummaryShots', { included: shots.included, excluded: shots.excludedOutOfScope }) : '',
                      casts?.included ? t('export.bundleSummaryCasts', { count: casts.included }) : ''
                    ].filter(Boolean).join('\n')
                    toast(t('export.done', { label: t('export.bundle') }), { type: 'success', why: r.outDir, detail })
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
