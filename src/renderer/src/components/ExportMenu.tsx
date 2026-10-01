import { useState, useRef, useEffect, useCallback } from 'react'
import { TITLEBAR_CONTROL } from './Button'
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

function fmtBytes(n: number | null): string {
  if (n === null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Every file the bundle would carry, one row each, with a switch (#222).
 *
 *  The counts above say how many; this says which. A terminal recording spans
 *  every command typed in it and RedLog never trims it, so a cast tied to
 *  several targets — or to none — is labelled as such and not presented as
 *  scope-clean. Leaving a row out re-resolves the plan: the exclusion is part
 *  of the request the fingerprint covers. */
function AttachmentList({ rows, onToggle, busy, t }: {
  rows: ExportAttachmentRow[]
  onToggle: (id: string) => void
  busy: boolean
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element | null {
  if (rows.length === 0) return null
  return (
    <div data-testid="export-attachments" className="px-3 py-1 border-t border-redlog-border mt-1 text-xs">
      <p className="text-redlog-text-dim mb-1">{t('export.attachments.title')}</p>
      <p className="text-redlog-text-faint mb-1">{t('export.attachments.castNote')}</p>
      <ul className="max-h-48 overflow-auto space-y-0.5">
        {rows.map((a) => {
          const selectable = a.status === 'included' || a.status === 'excluded-by-operator'
          const name = a.id.split('/').slice(1).join('/')
          const where = a.attribution === 'unattributed'
            ? t('export.attachments.unattributed')
            : a.attribution === 'cross-target'
              ? t('export.attachments.crossTarget', { targets: a.targets.join(', ') })
              : a.targets[0]
          const detail = [
            where,
            ...(a.source ? [a.source] : []),
            fmtBytes(a.bytes),
            ...(a.status !== 'included' ? [t(`export.attachments.status.${a.status}`)] : [])
          ].join(' · ')
          return (
            <li key={a.id} data-testid={`export-attachment-${a.id}`} data-status={a.status} className="flex items-start gap-2">
              <input
                type="checkbox"
                aria-label={a.id}
                checked={a.status === 'included'}
                disabled={busy || !selectable}
                onChange={() => onToggle(a.id)}
                className="mt-0.5 accent-red-600"
              />
              <span className="flex-1 min-w-0">
                <span className="block truncate font-mono text-redlog-text" title={a.id}>
                  {t(`export.attachments.kind.${a.kind}`)} · {name}
                </span>
                <span
                  title={detail}
                  className={`block truncate ${a.kind === 'cast' && a.attribution !== 'target' ? 'text-amber-400' : 'text-redlog-text-faint'}`}
                >
                  {detail}
                </span>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// These three are declared HERE, not inside ExportMenu.
//
// A component defined in another component's body is a new type on every
// render, so React unmounts and remounts its whole subtree each time: focus
// and state are lost on the keystroke that caused the render, and Fast Refresh
// cannot reconcile the old tree with the new one — which shows up as a panel
// that renders part of itself and stops. `Option` and `PreviewRow` had been
// that way; `Toggle` was added that way beside them.

function Option({ label, onPick, disabled: off, busy, hint }: {
  label: string; onPick: () => void; disabled?: boolean; busy?: boolean; hint?: string
}): JSX.Element {
  return (
    <button
      onClick={onPick}
      disabled={busy || off}
      className="w-full text-left px-3 py-2 hover:bg-redlog-elevated focus-visible:outline-none focus-visible:bg-redlog-elevated disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <span className="block text-xs text-redlog-text">{label}</span>
      {hint && <span className="block text-xs text-redlog-text-faint">{hint}</span>}
    </button>
  )
}

function PreviewRow({ label, value, warn }: {
  label: string; value: number; warn?: boolean
}): JSX.Element | null {
  if (value === 0) return null
  return (
    <div className="flex justify-between text-xs px-3 py-0.5">
      <span className={warn ? 'text-amber-500' : 'text-redlog-text-dim'}>{label}</span>
      <span className={`font-mono tabular-nums ${warn ? 'text-amber-500' : 'text-redlog-text'}`}>{value}</span>
    </div>
  )
}

/** One of the two things the 自用 / 交付 pair was standing in for. A mode named
 *  after an audience made the operator translate "who is this for" into "what
 *  comes out" every time — and it translated badly: its tooltip promised
 *  masked metadata, scrubbed PII and excluded infrastructure while the flag
 *  set exactly one of the three. */
function Toggle({ on, setOn, label, warn }: {
  on: boolean; setOn: (v: boolean) => void; label: string; warn?: boolean
}): JSX.Element {
  return (
    <label className="flex items-start gap-2 px-3 py-1.5 text-xs cursor-pointer">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => setOn(e.target.checked)}
        className="mt-0.5 accent-red-600"
      />
      <span className={warn ? 'text-amber-500' : 'text-redlog-text-dim'}>{label}</span>
    </label>
  )
}

export function ExportMenu({ totalCount }: ExportMenuProps): JSX.Element {
  const { t } = useI18n()
  const viewExport = useViewExport()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [scrubPii, setScrubPii] = useState(false)
  const [maskScope, setMaskScope] = useState(true)
  const [pending, setPending] = useState<PendingExport | null>(null)
  const [resolvedPlan, setResolvedPlan] = useState<ResolvedExportPlan | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  // A failed run keeps the dialog and its preview (UI/UX audit F12): closing
  // on failure threw away exactly what the operator had just reviewed.
  const [runError, setRunError] = useState<string | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)
  useFocusTrap(panel, open)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) {
        if (pending) { setPending(null); setResolvedPlan(null); setRunError(null) }
        else setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, pending, busy])

  const loadPreview = useCallback(async (p: PendingExport) => {
    setPending(p)
    setRunError(null)
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

  // Leaving an attachment in or out is a different export: the plan is
  // resolved again, so what is confirmed is what was previewed.
  const toggleAttachment = (id: string): void => {
    if (!pending || !resolvedPlan) return
    const current = new Set(resolvedPlan.request.excludeAttachments ?? [])
    if (current.has(id)) current.delete(id)
    else current.add(id)
    void loadPreview({ ...pending, request: { ...pending.request, excludeAttachments: [...current] } })
  }

  const closeAll = (): void => {
    setPending(null)
    setResolvedPlan(null)
    setPreviewError(null)
    setRunError(null)
    setOpen(false)
  }

  const confirmExport = async (): Promise<void> => {
    if (!pending) return
    setBusy(true)
    setRunError(null)
    try {
      if (!resolvedPlan) throw new Error('export plan unavailable')
      const result = await window.redlog.data.executeExportPlan({ planId: resolvedPlan.id })
      if (!result.ok) throw new Error(result.error)
      const path = result.artifactPath
      if (!path) throw new Error(t('toast.exportFailedWhy'))
      toast(t('export.done', { label: pending.label }), {
        type: 'success',
        why: path,
        action: { label: t('export.reveal'), onClick: () => { void window.redlog.data.revealExport?.(path) } },
        duration: 8000
      })
      closeAll()
    } catch (e) {
      // Stay open with the preview. A plan is single-use, so resolve it again
      // for the retry: the operator retries the same request, not a stale id.
      setRunError(String((e as Error)?.message ?? e))
      toast(t('export.failed', { label: pending.label }), {
        type: 'error',
        why: t('toast.exportFailedWhy'),
        detail: String((e as Error)?.message ?? e)
      })
    } finally {
      setBusy(false)
    }
  }

  const retryRun = async (): Promise<void> => {
    if (!pending) return
    await loadPreview(pending)
  }

  const empty = totalCount === 0

  // A format that cannot scrub is refused by the plan resolver, so it is not
  // offered while scrubbing is on.
  const cannotShare = (format: ExportFormat): boolean => scrubPii && !capabilitiesFor(format).piiScrubbing
  const shareHint = (format: ExportFormat): string | undefined => cannotShare(format) ? t('export.cannotScrub') : undefined

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t('export.title')}
        className={`${TITLEBAR_CONTROL} border-redlog-border bg-redlog-elevated text-redlog-text-dim hover:text-redlog-text hover:bg-redlog-elevated-hover focus-visible:ring-redlog-accent/40`}
      >
        <Download size={13} strokeWidth={1.5} aria-hidden />
        {t('export.title')}
        <ChevronDown size={12} strokeWidth={1.5} aria-hidden />
      </button>

      {open && (
        <>
          {/* The format picker is a menu under the button. The preview is a
              decision with a dozen facts and a file list in it, so it is a
              dialog of its own rather than a 280px popover (UI/UX audit F12). */}
          <div
            className={`fixed inset-0 z-[90] ${pending ? 'bg-black/60' : ''}`}
            onClick={() => { if (!busy) closeAll() }}
          />
          <div
            ref={panel}
            role={pending ? 'dialog' : 'menu'}
            aria-modal={pending ? true : undefined}
            aria-label={pending ? `${t('export.title')} · ${pending.label}` : t('export.title')}
            data-testid={pending ? 'export-dialog' : 'export-menu'}
            className={pending
              ? 'fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[91] w-[min(560px,92vw)] max-h-[82vh] overflow-y-auto bg-redlog-surface border border-redlog-border rounded-lg shadow-2xl py-1'
              : 'absolute right-0 top-7 z-[91] w-[280px] bg-redlog-surface border border-redlog-border rounded-lg shadow-2xl overflow-hidden py-1'}
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
                        <PreviewRow label={t('export.preview.attachmentsExcludedByOperator')} value={resolvedPlan.counts.attachmentsExcludedByOperator ?? 0} />
                        <AttachmentList rows={resolvedPlan.attachments ?? []} onToggle={toggleAttachment} busy={busy} t={t} />
                      </>
                    )}
                    <PreviewRow label={t('export.preview.unsupportedAttachments')} value={resolvedPlan.counts.unsupported} warn />
                    <div className="border-t border-redlog-border mt-1 pt-1">
                      <div className="flex justify-between text-xs px-3 py-0.5 font-medium">
                        <span className="text-redlog-text">{t('export.preview.included')}</span>
                        <span className="text-redlog-text font-mono tabular-nums">{resolvedPlan.counts.included}</span>
                      </div>
                    </div>
                    {runError && (
                      <div data-testid="export-run-error" role="alert" className="mx-3 mt-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                        <div>{t('export.runFailed')}</div>
                        <div className="mt-1 break-all font-mono text-redlog-text-faint">{runError}</div>
                        <button type="button" onClick={() => void retryRun()} className="mt-2 text-red-300 underline hover:text-red-200">
                          {t('export.retryResolve')}
                        </button>
                      </div>
                    )}
                    <div className="px-3 pt-2 pb-1 flex gap-2 justify-end">
                      <button
                        type="button"
                        onClick={() => { setPending(null); setResolvedPlan(null); setRunError(null) }}
                        disabled={busy}
                        className="px-3 py-1.5 text-xs text-redlog-text-dim hover:text-redlog-text disabled:opacity-40"
                      >
                        {t('common.cancel')}
                      </button>
                      <button
                        data-testid="export-confirm"
                        onClick={() => void confirmExport()}
                        disabled={busy || !!runError || resolvedPlan.counts.included === 0}
                        aria-busy={busy}
                        className="px-4 py-1.5 text-xs rounded bg-red-600 text-redlog-bg hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        {busy ? t('export.running') : t('export.preview.confirm')}
                      </button>
                    </div>
                  </div>
                ) : previewError ? (
                  <div data-testid="export-preview-error" role="alert" className="px-3 py-2 text-xs text-red-400">
                    <div>{t('export.failed', { label: pending.label })}: {previewError}</div>
                    <button type="button" onClick={() => void loadPreview(pending)} className="mt-2 text-red-300 underline hover:text-red-200">
                      {t('common.retry')}
                    </button>
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
                <Toggle on={scrubPii} setOn={setScrubPii} label={t('export.scrubPii')} />
                <Toggle
                  on={maskScope}
                  setOn={setMaskScope}
                  label={maskScope ? t('export.maskScope') : t('export.maskScopeOff')}
                  warn={!maskScope}
                />
                <div className="border-t border-redlog-border my-1" />
                {empty && (
                  <p className="px-3 py-1 text-xs text-redlog-text-faint italic">{t('export.empty')}</p>
                )}
                {viewExport && (
                  <Option
                    busy={busy}
                    label={viewExport.label}
                    disabled={empty || cannotShare(viewExport.request.format)}
                    hint={shareHint(viewExport.request.format)}
                    onPick={() => void loadPreview({ label: viewExport.label, request: { ...viewExport.request, scrubPii, maskOutOfScope: maskScope } })}
                  />
                )}
                <Option
                  busy={busy}
                  label={t('export.all')}
                  disabled={empty}
                  onPick={() => void loadPreview({ label: t('export.all'), request: { format: 'json', scrubPii, maskOutOfScope: maskScope } })}
                />
                <Option
                  busy={busy}
                  label={t('export.ndjson')}
                  disabled={empty}
                  onPick={() => void loadPreview({
                    label: t('export.ndjson'),
                    request: { format: 'ndjson', scrubPii, maskOutOfScope: maskScope }
                  })}
                />

                <div className="border-t border-redlog-border my-1" />
                {/* ── Evidence bundle (separate — different semantics) ── */}
                <Option
                  busy={busy}
                  label={t('export.bundle')}
                  disabled={empty || cannotShare('bundle')}
                  hint={shareHint('bundle')}
                  onPick={() => void loadPreview({
                    label: t('export.bundle'),
                    request: { format: 'bundle', scrubPii, maskOutOfScope: maskScope }
                  })}
                />
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
