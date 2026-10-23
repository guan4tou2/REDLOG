import { useState, useRef, useEffect, useCallback } from 'react'
import { TITLEBAR_CONTROL, TITLEBAR_ICON } from './Button'
import { useNarrowViewport } from '../hooks/useNarrowViewport'
import { Download, X } from 'lucide-react'
import { useI18n } from '../i18n'
import { useFocusTrap } from '../lib/useFocusTrap'
import { toast } from './Toast'
import { useViewExport } from '../lib/exportScope'
import { formatDateTime } from '../lib/time'
import { useSharedFilter, toEventFilter } from '../lib/FilterContext'
import { capabilitiesFor } from '../../../core/export-capabilities'
import { selectionConditions, subsetSummary } from '../lib/exportSubsetText'

export interface ExportMenuProps {
  totalCount?: number
  /** Opens Settings ▸ Scope, for the preview's "set a scope first". */
  onOpenScopeSettings?: () => void
}

/** Whether the plan was resolved against a web scope at all. Masking an empty
 *  scope masks nothing, so the preview must not say it did (Spec 060 FR-009). */
function planScopeSet(plan: { scopeSnapshot?: { targets?: string[]; excludeTargets?: string[] } }): boolean {
  return (plan.scopeSnapshot?.targets ?? []).length > 0 || (plan.scopeSnapshot?.excludeTargets ?? []).length > 0
}

/** What the preview says about scope, in the two places it is easy to assume
 *  wrongly: an empty scope is not "everything verified in scope", and the web
 *  scope does not select commands. Module scope on purpose — declared inside
 *  ExportMenu it would remount on every render. */
function ScopeNotes({ scopeSet, onSetScope, t }: {
  scopeSet: boolean
  onSetScope?: () => void
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element {
  return (
    <div className="px-3 pt-2 space-y-1 text-xs">
      {!scopeSet && (
        <div data-testid="export-scope-unset" className="text-amber-400 space-y-1">
          <p>{t('export.scopeUnset')}</p>
          {onSetScope && (
            <button type="button" data-testid="export-set-scope" onClick={onSetScope} className="underline hover:text-amber-300">
              {t('export.scopeSetFirst')}
            </button>
          )}
        </div>
      )}
      <p data-testid="export-commands-note" className="text-redlog-text-faint">{t('export.commandsNotScoped')}</p>
    </div>
  )
}

interface ExportDraft {
  format: ExportFormat
  range: 'current' | 'all'
  scrubPii: boolean
  maskScope: boolean
  excludeAttachments: string[]
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
      {rows.some(a => a.kind === 'cast' && a.status === 'included') && <p className="text-redlog-text-faint mb-1">{t('export.attachments.castNote')}</p>}
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
            <li key={a.id} data-testid={`export-attachment-${a.id}`} data-status={a.status} className="flex items-start gap-2 min-h-8 py-1">
              <input
                type="checkbox"
                aria-label={a.id}
                checked={a.status === 'included'}
                disabled={busy || !selectable}
                onChange={() => onToggle(a.id)}
                className="mt-0.5 w-4 h-4 shrink-0 accent-red-600"
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

// Keep helpers at module scope so editing a policy does not remount controls.
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
function Toggle({ on, setOn, label, warn, disabled }: {
  on: boolean; setOn: (v: boolean) => void; label: string; warn?: boolean; disabled?: boolean
}): JSX.Element {
  return (
    <label className="flex items-start gap-2 px-3 min-h-8 py-1.5 text-xs cursor-pointer">
      <input
        type="checkbox"
        checked={on}
        disabled={disabled}
        onChange={(e) => setOn(e.target.checked)}
        className="mt-0.5 w-4 h-4 shrink-0 accent-red-600"
      />
      <span className={`min-w-0 flex-1 ${warn ? 'text-amber-500' : 'text-redlog-text-dim'}`}>{label}</span>
    </label>
  )
}

const FORMAT_KEY = 'redlog.export.format'

/** Codes the export IPC returns that mean something specific to the operator;
 *  anything else is shown as the raw message alone. */
const KNOWN_RUN_ERRORS: ReadonlySet<string> = new Set(['source-unavailable', 'policy-changed', 'invalid-destination'])

export function ExportMenu({ totalCount, onOpenScopeSettings }: ExportMenuProps): JSX.Element {
  const { t } = useI18n()
  const narrow = useNarrowViewport()
  const viewExport = useViewExport()
  const { filter } = useSharedFilter()
  const currentSubset: ExportSubset = viewExport?.request.subset ?? { kind: 'selection', projection: 'events', filter: toEventFilter(filter) }
  const [draft, setDraft] = useState<ExportDraft>(() => {
    let format: ExportFormat = 'json'
    try {
      const saved = localStorage.getItem(FORMAT_KEY)
      if (saved === 'ndjson' || saved === 'bundle') format = saved
    } catch { /* remembering a format is optional */ }
    return { format, range: 'current' as 'current' | 'all', scrubPii: false, maskScope: true, excludeAttachments: [] as string[] }
  })
  // Freeze the declarative selection, never the currently loaded row ids.
  // Live view changes behind the dialog must not change what is reviewed.
  const selection = useRef<{ subset: ExportSubset; request?: ExportRequest; disabledReason?: string } | null>(null)
  const [destDir, setDestDir] = useState<string | null>(null)
  const [defaultDir, setDefaultDir] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<PendingExport | null>(null)
  const [resolvedPlan, setResolvedPlan] = useState<ResolvedExportPlan | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  // A failed run keeps the dialog and its preview (UI/UX audit F12): closing
  // on failure threw away exactly what the operator had just reviewed.
  const [runError, setRunError] = useState<string | null>(null)
  const previewSequence = useRef(0)
  const attachmentFocus = useRef<string | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)
  useFocusTrap(panel, open)

  const loadPreview = useCallback(async (p: PendingExport) => {
    const sequence = ++previewSequence.current
    void window.redlog.data.exportDestination?.().then((dir) => { if (sequence === previewSequence.current) setDefaultDir(dir) }).catch(() => {})
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
      if (sequence === previewSequence.current) setResolvedPlan(resolved.plan)
    } catch (error) {
        if (sequence === previewSequence.current) setPreviewError(String((error as Error)?.message ?? error))
    } finally {
      if (sequence === previewSequence.current) setPreviewLoading(false)
    }
  }, [])

  const requestFor = (next: typeof draft): ExportRequest => ({
    ...selection.current?.request,
    format: next.format,
    subset: next.range === 'all' ? { kind: 'all' } : selection.current!.subset,
    scrubPii: next.scrubPii,
    maskOutOfScope: capabilitiesFor(next.format).scopeMasking && next.maskScope,
    excludeAttachments: next.excludeAttachments
  })

  const updateDraft = (next: typeof draft): void => {
    setDraft(next)
    const p = { label: t(next.range === 'all' ? 'export.all' : 'export.current'), request: requestFor(next) }
    if (next.range === 'current' && selection.current?.disabledReason) {
      ++previewSequence.current
      setPending(p)
      setResolvedPlan(null)
      setPreviewLoading(false)
      setRunError(null)
      setPreviewError(selection.current.disabledReason)
      return
    }
    void loadPreview(p)
  }

  const openDialog = (): void => {
    selection.current = JSON.parse(JSON.stringify({ subset: currentSubset, request: viewExport?.request, disabledReason: viewExport?.disabledReason }))
    const format = viewExport?.request.format === 'har' || viewExport?.request.format === 'timeline'
      ? viewExport.request.format : draft.format === 'har' || draft.format === 'timeline' ? 'json' : draft.format
    setDestDir(null)
    setOpen(true)
    updateDraft({ ...draft, format, range: 'current', excludeAttachments: [], scrubPii: false })
  }

  const changeFormat = (format: ExportFormat): void => {
    if (draft.scrubPii && !capabilitiesFor(format).piiScrubbing) return
    if (format === 'json' || format === 'ndjson' || format === 'bundle') {
      try { localStorage.setItem(FORMAT_KEY, format) } catch { /* convenience only */ }
    }
    updateDraft({ ...draft, format })
  }

  const toggleAttachment = (id: string): void => {
    attachmentFocus.current = id
    const excluded = new Set(draft.excludeAttachments)
    if (excluded.has(id)) excluded.delete(id)
    else excluded.add(id)
    updateDraft({ ...draft, excludeAttachments: [...excluded] })
  }

  useEffect(() => {
    if (!resolvedPlan || !attachmentFocus.current) return
    const id = attachmentFocus.current
    attachmentFocus.current = null
    // Re-resolving replaces the attachment list. Restore its checkbox only
    // when focus fell to the body; never steal it from another draft control.
    if (document.activeElement === document.body) {
      const input = [...(panel.current?.querySelectorAll<HTMLInputElement>('input') ?? [])]
        .find(el => el.getAttribute('aria-label') === id)
      input?.focus()
    }
  }, [resolvedPlan])

  const closeAll = (): void => {
    attachmentFocus.current = null
    ++previewSequence.current
    setPending(null)
    setResolvedPlan(null)
    setPreviewError(null)
    setRunError(null)
    setOpen(false)
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) { e.preventDefault(); closeAll() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy])
  useEffect(() => () => { ++previewSequence.current }, [])

  const confirmExport = async (): Promise<void> => {
    if (!pending) return
    setBusy(true)
    setRunError(null)
    try {
      if (!resolvedPlan) throw new Error('export plan unavailable')
      const result = await window.redlog.data.executeExportPlan({ planId: resolvedPlan.id, ...(destDir ? { destDir } : {}) })
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

  const changeDestination = async (): Promise<void> => {
    const dir = await window.redlog.data.pickExportDir().catch(() => null)
    if (dir) setDestDir(dir)
  }

  const retryRun = async (): Promise<void> => {
    if (!pending) return
    // A destination main refused is not tried again; the default is.
    if (runError === 'invalid-destination') setDestDir(null)
    await loadPreview(pending)
  }

  const formats: ExportFormat[] = ['json', 'ndjson', 'bundle']
  const viewFormat = selection.current?.request?.format
  if (viewFormat === 'har' || viewFormat === 'timeline') formats.push(viewFormat)
  const capability = capabilitiesFor(draft.format)

  return (
    <div className="relative">
      {/* Narrow, the word and the chevron go and the icon stays (#298): the
          name is already the button's aria-label, and the strip has to keep
          room for the project's own name and the Mark button. */}
      <button
        onClick={() => { if (open) closeAll(); else openDialog() }}
        disabled={busy}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t('export.title')}
        title={narrow ? t('export.title') : undefined}
        className={`${narrow ? TITLEBAR_ICON : TITLEBAR_CONTROL} border-redlog-border bg-redlog-elevated text-redlog-text-dim hover:text-redlog-text hover:bg-redlog-elevated-hover focus-visible:ring-redlog-accent/40`}
      >
        <Download size={13} strokeWidth={1.5} aria-hidden />
        {!narrow && t('export.title')}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-[90] bg-black/60" onClick={() => { if (!busy) closeAll() }} />
          <div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-label={t('export.title')}
            data-testid="export-dialog"
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[91] w-[min(560px,92vw)] max-h-[82vh] flex flex-col overflow-hidden whitespace-normal break-words bg-redlog-surface border border-redlog-border rounded-lg shadow-2xl"
          >
            <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-redlog-border">
              <h2 className="text-sm text-redlog-text">{t('export.title')}</h2>
              <button type="button" onClick={closeAll} disabled={busy} aria-label={t('common.close')} className="p-1 text-redlog-text-dim hover:text-redlog-text disabled:opacity-40"><X size={16} /></button>
            </div>
            <div className="min-h-0 overflow-y-auto">
            <div className="px-3 pt-3 pb-2 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <label className="min-w-0 text-redlog-text-dim">
                {t('export.rangeLabel')}
                <select aria-label={t('export.rangeLabel')} value={draft.range} disabled={busy} onChange={e => updateDraft({ ...draft, range: e.target.value as 'current' | 'all' })} className="mt-1 block w-full bg-redlog-elevated border border-redlog-border rounded px-2 py-1.5 text-redlog-text">
                  <option value="current">{t('export.current')}</option>
                  <option value="all">{t('export.range.all')}</option>
                </select>
              </label>
              <label className="min-w-0 text-redlog-text-dim">
                {t('export.currentFormat')}
                <select aria-label={t('export.currentFormat')} value={draft.format} disabled={busy} onChange={e => changeFormat(e.target.value as ExportFormat)} className="mt-1 block w-full bg-redlog-elevated border border-redlog-border rounded px-2 py-1.5 text-redlog-text">
                  {formats.map(format => <option key={format} value={format} disabled={draft.scrubPii && !capabilitiesFor(format).piiScrubbing}>{format === 'bundle' ? t('export.bundle') : format.toUpperCase()}</option>)}
                </select>
              </label>
            </div>
            <p data-testid="export-range-current" className="px-3 pb-1 text-xs text-redlog-text-dim">{draft.range === 'current' ? t('export.range.current', { summary: subsetSummary(selection.current!.subset, t) }) : t('export.range.allHint')}</p>
            <p className="px-3 pb-2 text-xs text-redlog-text-faint">{t(`export.formatHelp.${draft.format}`)}</p>
            {totalCount === 0 && <p className="px-3 pb-2 text-xs text-redlog-text-faint">{t('export.empty')}</p>}
            <Toggle on={draft.scrubPii} setOn={scrubPii => updateDraft({ ...draft, scrubPii })} label={t('export.scrubPii')} disabled={busy || !capability.piiScrubbing} />
            {!capability.piiScrubbing && <p className="px-3 text-xs text-redlog-text-faint">{t('export.cannotScrub')}</p>}
            <Toggle on={capability.scopeMasking && draft.maskScope} setOn={maskScope => updateDraft({ ...draft, maskScope })} label={draft.maskScope ? t('export.maskScope') : t('export.maskScopeOff')} warn={!draft.maskScope} disabled={busy || !capability.scopeMasking} />
            {!capability.scopeMasking && <p className="px-3 text-xs text-redlog-text-faint">{t('export.cannotMask')}</p>}
            <div className="border-t border-redlog-border mt-2 pt-2" aria-busy={previewLoading}>
                {previewLoading ? (
                  <p role="status" className="px-3 py-3 text-xs text-redlog-text-faint text-center">{t('export.preview.loading')}</p>
                ) : resolvedPlan ? (
                  <div className="py-1">
                    {(
                      <div className="px-3 pb-2 mb-1 border-b border-redlog-border text-xs space-y-1">
                        <div className="flex justify-between gap-3">
                          <span className="text-redlog-text-dim shrink-0">{t('export.preview.format')}</span>
                          <span className="font-mono text-redlog-text">{resolvedPlan.request.format.toUpperCase()}</span>
                        </div>
                        <div className="flex justify-between gap-3">
                          <span className="text-redlog-text-dim shrink-0">{t('export.preview.subset')}</span>
                          {/* The actual boundary, not just "bounded": an
                              operator checking a delivery needs the dates and
                              the target they are about to hand over. */}
                          {/* min-w-0: a flex item will not shrink below its
                              content's intrinsic minimum, so without this the
                              joined condition line pushes the dialog wider than
                              the window instead of wrapping. English only —
                              CJK breaks anywhere and hid this in zh-TW. */}
                          <span data-testid="export-preview-subset" className="min-w-0 text-right text-redlog-text">
                            {resolvedPlan.request.subset.kind === 'all'
                              ? t('export.preview.subsetAll')
                              : resolvedPlan.request.subset.kind === 'selection'
                                ? <span className="break-words">{t('export.current')}<br />{selectionConditions(resolvedPlan.request.subset, t).join(' · ')}</span>
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
                          <span className="text-redlog-text-dim shrink-0">{t('export.preview.policy')}</span>
                          <span data-testid="export-preview-policy" className="text-right text-redlog-text">
                            {[
                              !resolvedPlan.request.maskOutOfScope
                                ? t('export.preview.policyNoMask')
                                : planScopeSet(resolvedPlan) ? t('export.preview.policyMask') : t('export.preview.policyNoScope'),
                              ...(resolvedPlan.request.scopeOnly ? [t('export.preview.policyScopeOnly')] : []),
                              ...(resolvedPlan.request.scrubPii ? [t('export.preview.policyScrubPii')] : [])
                            ].join(' · ')}
                          </span>
                        </div>
                        <div className="flex justify-between gap-3">
                          <span className="text-redlog-text-dim shrink-0">{t('export.preview.scope')}</span>
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
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-redlog-text-dim shrink-0">{t('export.preview.destination')}</span>
                          <span className="flex min-w-0 items-center gap-2">
                            <span data-testid="export-destination" title={destDir ?? defaultDir ?? undefined} className="min-w-0 truncate font-mono text-redlog-text">
                              {destDir ?? defaultDir ?? t('export.preview.destinationDefault')}
                            </span>
                            <button type="button" data-testid="export-change-destination" onClick={() => void changeDestination()} disabled={busy} className="shrink-0 text-redlog-text-dim underline hover:text-redlog-text disabled:opacity-40">
                              {t('export.preview.destinationChange')}
                            </button>
                          </span>
                        </div>
                      </div>
                    )}
                    {/* Every row below is a number the resolver measured.
                        `inScope` used to be `included - maskedOutOfScope`,
                        which is not a scope classification, and `screenshots`
                        was hardcoded 0 - both are gone rather than guessed. */}
                    <ScopeNotes
                      scopeSet={planScopeSet(resolvedPlan)}
                      onSetScope={onOpenScopeSettings && !busy ? () => { closeAll(); onOpenScopeSettings() } : undefined}
                      t={t}
                    />
                    {resolvedPlan.request.subset.kind !== 'all' && <p data-testid="export-projection-notice" className="px-3 py-2 text-xs text-amber-400">{t('export.projectionNotice')}</p>}
                    {resolvedPlan.counts.exchanges !== undefined && <p className="px-3 text-xs">{t('export.exchanges', { count: resolvedPlan.counts.exchanges })}</p>}
                    <PreviewRow label={t('export.preview.total')} value={resolvedPlan.counts.examined} />
                    {planScopeSet(resolvedPlan) && <PreviewRow label={t('export.preview.outOfScope')} value={resolvedPlan.counts.maskedOutOfScope} warn />}
                    <PreviewRow label={t('export.preview.dropped')} value={resolvedPlan.counts.excludedDoNotExport} warn />
                    <PreviewRow label={t('export.preview.personalDropped')} value={resolvedPlan.counts.excludedPersonal} warn />
                    <PreviewRow label={t('export.preview.sanitized')} value={resolvedPlan.counts.sanitized} />
                    {/* Three different things that all used to read as "0
                        attachments": this format carries none, none were
                        referenced, or some could not be attached. */}
                    {!resolvedPlan.capabilities.attachments ? (
                      <div data-testid="export-preview-no-attachments" className="flex justify-between text-xs px-3 py-0.5">
                        <span className="text-redlog-text-dim">{t('export.preview.attachments')}</span>
                        <span className="text-redlog-text-faint">{t('export.preview.attachmentsUnsupported')}</span>
                      </div>
                    ) : (
                      <>
                        <PreviewRow label={t('export.preview.attachments')} value={resolvedPlan.counts.attachmentsIncluded} />
                        <PreviewRow label={t('export.preview.attachmentsMissing')} value={resolvedPlan.counts.attachmentsMissing} warn />
                        <PreviewRow label={t('export.preview.attachmentsUnattributed')} value={resolvedPlan.counts.attachmentsUnattributed} warn />
                        <PreviewRow label={t('export.preview.attachmentsExcludedByOperator')} value={resolvedPlan.counts.attachmentsExcludedByOperator ?? 0} />
                        <AttachmentList rows={resolvedPlan.attachments ?? []} onToggle={toggleAttachment} busy={busy || previewLoading} t={t} />
                      </>
                    )}
                    <PreviewRow label={t('export.preview.unsupportedAttachments')} value={resolvedPlan.counts.unsupported} warn />
                    <PreviewRow label={t('export.preview.truncatedOutputs')} value={resolvedPlan.counts.truncatedOutputs ?? 0} warn />
                    <PreviewRow label={t('export.preview.pauseWindows')} value={resolvedPlan.counts.pauseWindows ?? 0} warn />
                    <div className="border-t border-redlog-border mt-1 pt-1">
                      <div className="flex justify-between text-xs px-3 py-0.5 font-medium">
                        <span className="text-redlog-text">{t('export.preview.included')}</span>
                        <span className="text-redlog-text font-mono tabular-nums">{resolvedPlan.counts.included}</span>
                      </div>
                    </div>
                    {runError && (
                      <div data-testid="export-run-error" role="alert" className="mx-3 mt-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                        <div>{t('export.runFailed')}</div>
                        {KNOWN_RUN_ERRORS.has(runError) && <div data-testid="export-run-error-meaning" className="mt-1">{t(`export.error.${runError}`)}</div>}
                        <div className="mt-1 break-all font-mono text-redlog-text-faint">{runError}</div>
                        <button type="button" onClick={() => void retryRun()} className="mt-2 text-red-300 underline hover:text-red-200">
                          {t('export.retryResolve')}
                        </button>
                      </div>
                    )}
                  </div>
                ) : previewError ? (
                  <div data-testid="export-preview-error" role="alert" className="px-3 py-2 text-xs text-red-400">
                    <div>{t('export.failed', { label: pending?.label ?? t('export.title') })}: {previewError}</div>
                    <button type="button" onClick={() => { if (pending) updateDraft(draft) }} className="mt-2 text-red-300 underline hover:text-red-200">
                      {t('common.retry')}
                    </button>
                  </div>
                ) : null}
            </div>
            </div>
            <div className="shrink-0 bg-redlog-surface border-t border-redlog-border px-3 py-2 flex gap-2 justify-end">
              <button type="button" onClick={closeAll} disabled={busy} className="px-3 py-1.5 text-xs text-redlog-text-dim hover:text-redlog-text disabled:opacity-40">{t('common.cancel')}</button>
              {resolvedPlan && !previewLoading && <button data-testid="export-confirm" onClick={() => void confirmExport()} disabled={busy || !!runError || resolvedPlan.counts.included === 0} aria-busy={busy} className="px-4 py-1.5 text-xs rounded bg-red-600 text-redlog-bg hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">{busy ? t('export.running') : t('export.preview.confirm')}</button>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
