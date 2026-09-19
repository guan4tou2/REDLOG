import { useState, useRef, useEffect, useCallback } from 'react'
import { Download, ChevronDown, ChevronLeft } from 'lucide-react'
import { useI18n } from '../i18n'
import { useFocusTrap } from '../lib/useFocusTrap'
import { toast } from './Toast'
import { useViewExport } from '../lib/exportScope'

export interface ExportMenuProps {
  totalCount?: number
}

interface PendingExport {
  label: string
  fn: () => Promise<string | null>
  sharing?: boolean
}

export function ExportMenu({ totalCount }: ExportMenuProps): JSX.Element {
  const { t } = useI18n()
  const viewExport = useViewExport()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [maskScope, setMaskScope] = useState(true)
  const [pending, setPending] = useState<PendingExport | null>(null)
  const [preview, setPreview] = useState<ExportPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const panel = useRef<HTMLDivElement | null>(null)
  useFocusTrap(panel, open)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (pending) { setPending(null); setPreview(null) }
        else setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, pending])

  const loadPreview = useCallback(async (p: PendingExport) => {
    setPending(p)
    setPreviewLoading(true)
    setPreview(null)
    try {
      const result = await window.redlog.data.exportPreview?.({ sharing: p.sharing })
      setPreview(result ?? null)
    } catch {
      setPreview(null)
    } finally {
      setPreviewLoading(false)
    }
  }, [])

  const confirmExport = async (): Promise<void> => {
    if (!pending) return
    setBusy(true)
    try {
      const path = await pending.fn()
      if (path) toast(t('export.done', { label: pending.label }), { type: 'success', why: path })
      else toast(t('export.failed', { label: pending.label }), { type: 'error', why: t('toast.exportFailedWhy') })
    } catch (e) {
      toast(t('export.failed', { label: pending.label }), {
        type: 'error',
        why: t('toast.exportFailedWhy'),
        detail: String((e as Error)?.message ?? e)
      })
    } finally {
      setBusy(false)
      setPending(null)
      setPreview(null)
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

  const PreviewRow = ({ label, value, warn }: { label: string; value: number; warn?: boolean }): JSX.Element | null => {
    if (value === 0) return null
    return (
      <div className="flex justify-between text-xs px-3 py-0.5">
        <span className={warn ? 'text-amber-500' : 'text-redlog-text-dim'}>{label}</span>
        <span className={`font-mono tabular-nums ${warn ? 'text-amber-500' : 'text-redlog-text'}`}>{value}</span>
      </div>
    )
  }

  const PresetToggle = (): JSX.Element => (
    <div className="px-3 py-1.5">
      <div className="flex rounded border border-redlog-border overflow-hidden">
        <button
          onClick={() => setSharing(false)}
          className={`flex-1 px-2 py-1 text-xs transition-colors ${
            !sharing
              ? 'bg-redlog-elevated text-redlog-text'
              : 'text-redlog-text-dim hover:text-redlog-text'
          }`}
          title={t('export.preset.mergeHint')}
        >
          {t('export.preset.merge')}
        </button>
        <button
          onClick={() => setSharing(true)}
          className={`flex-1 px-2 py-1 text-xs transition-colors border-l border-redlog-border ${
            sharing
              ? 'bg-red-600/15 text-red-400'
              : 'text-redlog-text-dim hover:text-redlog-text'
          }`}
          title={t('export.preset.deliveryHint')}
        >
          {t('export.preset.delivery')}
        </button>
      </div>
    </div>
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
          <div className="fixed inset-0 z-[90]" onClick={() => { setPending(null); setPreview(null); setOpen(false) }} />
          <div
            ref={panel}
            role="menu"
            aria-label={t('export.title')}
            className="absolute right-0 top-7 z-[91] w-[280px] bg-redlog-surface border border-redlog-border rounded-lg shadow-2xl overflow-hidden py-1"
          >
            {pending ? (
              /* ── Preview panel ── */
              <div>
                <button
                  onClick={() => { setPending(null); setPreview(null) }}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs text-redlog-text-dim hover:text-redlog-text w-full"
                >
                  <ChevronLeft size={12} />
                  {pending.label}
                </button>
                <div className="border-t border-redlog-border" />
                {previewLoading ? (
                  <p className="px-3 py-3 text-xs text-redlog-text-faint text-center">{t('export.preview.loading')}</p>
                ) : preview ? (
                  <div className="py-1">
                    <PreviewRow label={t('export.preview.total')} value={preview.total} />
                    <PreviewRow label={t('export.preview.inScope')} value={preview.inScope} />
                    <PreviewRow label={t('export.preview.outOfScope')} value={preview.outOfScope} warn />
                    <PreviewRow label={t('export.preview.dropped')} value={preview.dropped} warn />
                    <PreviewRow label={t('export.preview.personalDropped')} value={preview.personalDropped} warn />
                    <PreviewRow label={t('export.preview.blacklisted')} value={preview.blacklisted} warn />
                    <PreviewRow label={t('export.preview.sanitized')} value={preview.sanitized} />
                    <PreviewRow label={t('export.preview.bodyRefs')} value={preview.withBodyRefs} />
                    <PreviewRow label={t('export.preview.screenshots')} value={preview.screenshotEvents} />
                    <div className="border-t border-redlog-border mt-1 pt-1">
                      <div className="flex justify-between text-xs px-3 py-0.5 font-medium">
                        <span className="text-redlog-text">{t('export.preview.included')}</span>
                        <span className="text-redlog-text font-mono tabular-nums">{preview.included}</span>
                      </div>
                    </div>
                    <div className="px-3 pt-2 pb-1">
                      <button
                        onClick={() => void confirmExport()}
                        disabled={busy || preview.included === 0}
                        className="w-full px-3 py-1.5 text-xs rounded bg-red-600 text-redlog-bg hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        {busy ? '…' : t('export.preview.confirm')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="px-3 py-2">
                    <button
                      onClick={() => void confirmExport()}
                      disabled={busy}
                      className="w-full px-3 py-1.5 text-xs rounded bg-red-600 text-redlog-bg hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {busy ? '…' : t('export.preview.confirm')}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              /* ── Format picker ── */
              <>
                <PresetToggle />
                <div className="border-t border-redlog-border my-1" />
                {empty && (
                  <p className="px-3 py-1 text-xs text-redlog-text-faint italic">{t('export.empty')}</p>
                )}
                {viewExport && (
                  <Option
                    label={viewExport.label}
                    disabled={empty}
                    onPick={() => void loadPreview({ label: viewExport.label, sharing, fn: () => viewExport.run({ sharing }) })}
                  />
                )}
                <Option
                  label={t('export.all')}
                  disabled={empty}
                  onPick={() => void loadPreview({ label: t('export.all'), sharing, fn: () => window.redlog.data.exportJson({ sharing }) })}
                />
                <Option
                  label={t('export.ndjson')}
                  disabled={empty}
                  onPick={() => void loadPreview({
                    label: t('export.ndjson'),
                    sharing,
                    fn: () => {
                      const api = window.redlog.data as { exportNdjson?: (opts?: { sharing?: boolean }) => Promise<string | null> }
                      return api.exportNdjson?.({ sharing }) ?? Promise.resolve(null)
                    }
                  })}
                />

                <div className="border-t border-redlog-border my-1" />
                {/* ── Evidence bundle (separate — different semantics) ── */}
                <Option
                  label={t('export.bundle')}
                  disabled={empty}
                  onPick={() => void loadPreview({
                    label: t('export.bundle'),
                    sharing,
                    fn: async () => {
                      const api = window.redlog.data as { exportBundle?: (opts?: { maskOutOfScope?: boolean }) => Promise<{ ok: boolean; outDir?: string; error?: string }> }
                      if (!api.exportBundle) return null
                      const r = await api.exportBundle({ maskOutOfScope: maskScope })
                      return r.ok && r.outDir ? r.outDir : null
                    }
                  })}
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
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
