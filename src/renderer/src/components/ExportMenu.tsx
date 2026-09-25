import { useState, useRef, useEffect, useCallback } from 'react'
import { Download, ChevronDown, ChevronLeft } from 'lucide-react'
import { useI18n } from '../i18n'
import { useFocusTrap } from '../lib/useFocusTrap'
import { toast } from './Toast'
import { useViewExport } from '../lib/exportScope'
import { formatDateTime } from '../lib/time'
import { capabilitiesFor } from '../../../core/export-capabilities'

export interface ExportMenuProps {
  totalCount?: number
}

interface PendingExport {
  label: string
  request: ExportRequest
}

export function ExportMenu({ totalCount }: ExportMenuProps): JSX.Element {
  const { t } = useI18n()
  const viewExport = useViewExport()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [maskScope, setMaskScope] = useState(true)
  const [pending, setPending] = useState<PendingExport | null>(null)
  const [resolvedPlan, setResolvedPlan] = useState<ResolvedExportPlan | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const panel = useRef<HTMLDivElement | null>(null)
  useFocusTrap(panel, open)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (pending) { setPending(null); setResolvedPlan(null) }
        else setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, pending])

  const loadPreview = useCallback(async (p: PendingExport) => {
    setPending(p)
    setPreviewLoading(true)
    setResolvedPlan(null)
    setPreviewError(null)
    try {
      const resolved = await window.redlog.data.resolveExportPlan(p.request)
      if (!resolved.ok) throw new Error(resolved.error)
      // The plan IS the preview. This used to be reshaped into an
      // `ExportPreview` whose `hasScope`, `screenshotEvents` and `snapshot`
      // were hardcoded to false/0/zeros, and whose `inScope` was
      // `included - maskedOutOfScope` — arithmetic, not a scope
      // classification. An operator checking what they are about to hand over
      // was reading numbers RedLog had made up.
      setResolvedPlan(resolved.plan)
    } catch (error) {
        setPreviewError(String((error as Error)?.message ?? error))
    } finally {
      setPreviewLoading(false)
    }
  }, [t])

  const confirmExport = async (): Promise<void> => {
    if (!pending) return
    setBusy(true)
    try {
      if (!resolvedPlan) throw new Error('export plan unavailable')
      const result = await window.redlog.data.executeExportPlan({ planId: resolvedPlan.id })
      if (!result.ok) throw new Error(result.error)
      const path = result.artifactPath
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
        setResolvedPlan(null)
      setPreviewError(null)
      setOpen(false)
    }
  }

  const empty = totalCount === 0

  const Option = ({ label, onPick, disabled: off, hint }: {
    label: string; onPick: () => void; disabled?: boolean; hint?: string
  }): JSX.Element => (
    <button
      onClick={onPick}
      disabled={busy || off}
      className="w-full text-left px-3 py-2 hover:bg-redlog-elevated focus-visible:outline-none focus-visible:bg-redlog-elevated disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <span className="block text-xs text-redlog-text">{label}</span>
      {hint && <span className="block text-xs text-redlog-text-faint">{hint}</span>}
    </button>
  )
  // Sharing mode scrubs operator PII; a format that cannot is refused by the
  // plan resolver, so it is not offered here.
  const cannotShare = (format: ExportFormat): boolean => sharing && !capabilitiesFor(format).piiScrubbing
  const shareHint = (format: ExportFormat): string | undefined => cannotShare(format) ? t('export.cannotScrub') : undefined

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
          <div className="fixed inset-0 z-[90]" onClick={() => { setPending(null); setResolvedPlan(null); setOpen(false) }} />
          <div
            ref={panel}
            role="menu"
            aria-label={t('export.title')}
            className="absolute right-0 top-7 z-[91] w-[280px] bg-redlog-surface border border-redlog-border rounded-lg shadow-2xl overflow-hidden py-1"
          >
            {pending ? (
              /* ── Preview panel ── */
              <div aria-busy={previewLoading} aria-live="polite">
                <button
                  onClick={() => { setPending(null); setResolvedPlan(null) }}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs text-redlog-text-dim hover:text-redlog-text w-full"
                >
                  <ChevronLeft size={12} />
                  {pending.label}
                </button>
                <div className="border-t border-redlog-border" />
                {previewLoading ? (
                  <p className="px-3 py-3 text-xs text-redlog-text-faint text-center">{t('export.preview.loading')}</p>
                ) : resolvedPlan ? (
                  <div className="py-1">
                    {(
                      <div className="px-3 pb-2 mb-1 border-b border-redlog-border text-xs space-y-1">
                        <div className="flex justify-between gap-3">
                          <span className="text-redlog-text-dim">{t('export.preview.format')}</span>
                          <span className="font-mono text-redlog-text">{resolvedPlan.request.format.toUpperCase()}</span>
                        </div>
                        <div className="flex justify-between gap-3">
                          <span className="text-redlog-text-dim">{t('export.preview.subset')}</span>
                          {/* The actual boundary, not just "bounded": an
                              operator checking a delivery needs the dates and
                              the target they are about to hand over. */}
                          <span data-testid="export-preview-subset" className="text-right text-redlog-text">
                            {resolvedPlan.request.subset.kind === 'all'
                              ? t('export.preview.subsetAll')
                              : <>
                                  {formatDateTime(resolvedPlan.request.subset.since, { seconds: true })}
                                  {' → '}
                                  {formatDateTime(resolvedPlan.request.subset.before, { seconds: true })}
                                  {resolvedPlan.request.subset.targetId
                                    && <><br />{t('export.preview.subsetTarget', { target: resolvedPlan.request.subset.targetId })}</>}
                                </>}
                          </span>
                        </div>
                        <div className="flex justify-between gap-3">
                          <span className="text-redlog-text-dim">{t('export.preview.policy')}</span>
                          <span data-testid="export-preview-policy" className="text-right text-redlog-text">
                            {[
                              resolvedPlan.request.sharing ? t('export.preset.delivery') : t('export.preset.merge'),
                              resolvedPlan.request.maskOutOfScope ? t('export.preview.policyMask') : t('export.preview.policyNoMask'),
                              ...(resolvedPlan.request.scopeOnly ? [t('export.preview.policyScopeOnly')] : []),
                              ...(resolvedPlan.request.scrubPii ? [t('export.preview.policyScrubPii')] : [])
                            ].join(' · ')}
                          </span>
                        </div>
                        <div className="flex justify-between gap-3">
                          <span className="text-redlog-text-dim">{t('export.preview.scope')}</span>
                          <span data-testid="export-preview-scope" className="text-right text-redlog-text">
                            {(resolvedPlan.scopeSnapshot?.targets ?? []).length === 0
                              ? t('export.preview.scopeNone')
                              : resolvedPlan.scopeSnapshot.targets.join(', ')}
                          </span>
                        </div>
                        <div className="flex justify-between gap-3" title={resolvedPlan.fingerprint}>
                          <span className="text-redlog-text-dim">{t('export.preview.fingerprint')}</span>
                          <span className="font-mono text-redlog-text">{resolvedPlan.fingerprint.slice(0, 12)}</span>
                        </div>
                        <div className="flex justify-between gap-3">
                          <span className="text-redlog-text-dim">{t('export.preview.boundary')}</span>
                          <span className="text-right text-redlog-text">
                            {formatDateTime(resolvedPlan.snapshot.takenAt, { seconds: true })}
                          </span>
                        </div>
                      </div>
                    )}
                    {/* Every row below is a number the resolver measured.
                        `inScope` used to be `included - maskedOutOfScope`,
                        which is not a scope classification, and `screenshots`
                        was hardcoded 0 - both are gone rather than guessed. */}
                    <PreviewRow label={t('export.preview.total')} value={resolvedPlan.counts.examined} />
                    <PreviewRow label={t('export.preview.outOfScope')} value={resolvedPlan.counts.maskedOutOfScope} warn />
                    <PreviewRow label={t('export.preview.dropped')} value={resolvedPlan.counts.excludedDoNotExport} warn />
                    <PreviewRow label={t('export.preview.personalDropped')} value={resolvedPlan.counts.excludedPersonal} warn />
                    <PreviewRow label={t('export.preview.blacklisted')} value={resolvedPlan.counts.excludedBlacklist} warn />
                    <PreviewRow label={t('export.preview.sanitized')} value={resolvedPlan.counts.sanitized} />
                    {/* Three different things that all used to read as "0
                        attachments": this format carries none, none were
                        referenced, or some could not be attached. */}
                    {!resolvedPlan.capabilities.attachments ? (
                      <div data-testid="export-preview-no-attachments" className="flex justify-between text-xs px-3 py-0.5">
                        <span className="text-redlog-text-dim">{t('export.preview.bodyRefs')}</span>
                        <span className="text-redlog-text-faint">{t('export.preview.attachmentsUnsupported')}</span>
                      </div>
                    ) : (
                      <>
                        <PreviewRow label={t('export.preview.bodyRefs')} value={resolvedPlan.counts.attachmentsIncluded} />
                        <PreviewRow label={t('export.preview.attachmentsMissing')} value={resolvedPlan.counts.attachmentsMissing} warn />
                        <PreviewRow label={t('export.preview.attachmentsUnattributed')} value={resolvedPlan.counts.attachmentsUnattributed} warn />
                      </>
                    )}
                    <PreviewRow label={t('export.preview.unsupportedAttachments')} value={resolvedPlan.counts.unsupported} warn />
                    <div className="border-t border-redlog-border mt-1 pt-1">
                      <div className="flex justify-between text-xs px-3 py-0.5 font-medium">
                        <span className="text-redlog-text">{t('export.preview.included')}</span>
                        <span className="text-redlog-text font-mono tabular-nums">{resolvedPlan.counts.included}</span>
                      </div>
                    </div>
                    <div className="px-3 pt-2 pb-1">
                      <button
                        onClick={() => void confirmExport()}
                        disabled={busy || resolvedPlan.counts.included === 0}
                        className="w-full px-3 py-1.5 text-xs rounded bg-red-600 text-redlog-bg hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        {busy ? '…' : t('export.preview.confirm')}
                      </button>
                    </div>
                  </div>
                ) : previewError ? (
                  <div role="alert" className="px-3 py-2 text-xs text-red-400">
                    {t('export.failed', { label: pending.label })}: {previewError}
                  </div>
                ) : (
                  <div className="px-3 py-2">
                    <button
                      onClick={() => void confirmExport()}
                      disabled
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
                    disabled={empty || cannotShare(viewExport.request.format)}
                    hint={shareHint(viewExport.request.format)}
                    onPick={() => void loadPreview({ label: viewExport.label, request: { ...viewExport.request, sharing } })}
                  />
                )}
                <Option
                  label={t('export.all')}
                  disabled={empty}
                  onPick={() => void loadPreview({ label: t('export.all'), request: { format: 'json', sharing } })}
                />
                <Option
                  label={t('export.ndjson')}
                  disabled={empty}
                  onPick={() => void loadPreview({
                    label: t('export.ndjson'),
                    request: { format: 'ndjson', sharing }
                  })}
                />

                <div className="border-t border-redlog-border my-1" />
                {/* ── Evidence bundle (separate — different semantics) ── */}
                <Option
                  label={t('export.bundle')}
                  disabled={empty || cannotShare('bundle')}
                  hint={shareHint('bundle')}
                  onPick={() => void loadPreview({
                    label: t('export.bundle'),
                    request: { format: 'bundle', sharing, maskOutOfScope: maskScope }
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
