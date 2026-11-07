import { useEffect, useId, useRef, useState } from 'react'
import { ChevronRight, FolderOpen, Upload, X } from 'lucide-react'
import { useI18n } from '../i18n'
import { toast } from './Toast'
import { Button } from './Button'
import { Modal } from './Modal'
import { ListField } from './settings/SettingsShared'
import { parseScopeInput } from '../lib/scopeInput'
import { profileSummary, profileToInitialConfig, type ImportedProfile, type ProfileFailure } from '../../../core/profile-import'

type Translate = (key: string, vars?: Record<string, string | number>) => string

function describeFailure(f: ProfileFailure, t: Translate): string {
  switch (f.code) {
    case 'read': return t('project.importFailedRead', { detail: f.detail })
    case 'parse': return t('project.importFailedParse', { detail: f.detail })
    case 'empty': return t('project.importFailedEmpty')
    case 'shape': return t('project.importFailedShape', { field: f.field, expected: t(`project.expect.${f.expected}`) })
  }
}

/** Entries still sitting in a scope box when the form is submitted. Valid ones
 *  are taken as if "+" had been pressed; any invalid one stops the create and
 *  is named, because silently dropping it would create a project without a
 *  target the operator typed. */
function takeResidual(items: string[], draft: string): { items: string[]; invalid: string[] } {
  if (!draft.trim()) return { items, invalid: [] }
  const { valid, invalid } = parseScopeInput(draft)
  return { items: [...items, ...valid.filter((v) => !items.includes(v))], invalid }
}

/** Stitch 01: the create-project dialog. Title bar with a close control, a
 *  body that scrolls, and a footer that stays put. The project's own folder
 *  name is chosen by RedLog, so the dialog shows where projects live rather
 *  than a guessed path. */
export function CreateProjectModal({ open, onClose, onCreated, root }: {
  open: boolean
  onClose: () => void
  onCreated: (project: { id: string; name: string }) => void
  /** The directory projects are created in; null while unknown. */
  root: string | null
}): JSX.Element {
  const { t } = useI18n()
  const titleId = useId()
  const nameInput = useRef<HTMLInputElement | null>(null)
  const [name, setName] = useState('')
  const [nameMissing, setNameMissing] = useState(false)
  const [createError, setCreateError] = useState('')
  const [creating, setCreating] = useState(false)
  const createPending = useRef(false)
  const [importing, setImporting] = useState(false)
  const importPending = useRef(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // The safe/exposed IPs and the violation warning are owned by Settings; the
  // form holds them only when a profile was imported (#297). Targets typed
  // here are added to what the profile carries — importing never discards
  // what was typed (#588).
  const [imported, setImported] = useState<ImportedProfile | null>(null)
  const [importFailure, setImportFailure] = useState<ProfileFailure | null>(null)
  const [targets, setTargets] = useState<string[]>([])
  const [excludes, setExcludes] = useState<string[]>([])
  const [targetDraft, setTargetDraft] = useState('')
  const [excludeDraft, setExcludeDraft] = useState('')
  const [residualInvalid, setResidualInvalid] = useState<string[]>([])

  // A draft survives closing the dialog (Escape, Cancel, ×): what was typed is
  // still there when it is opened again, as before the dialog had a title bar.
  // Only the "name missing" prompt starts over.
  useEffect(() => { if (open) setNameMissing(false) }, [open])

  const busy = creating || importing
  const close = (): void => { if (!busy) onClose() }

  async function handleCreate(): Promise<void> {
    const trimmed = name.trim()
    if (createPending.current || importPending.current) return
    if (!trimmed) { setNameMissing(true); nameInput.current?.focus(); return }
    const tgt = takeResidual(targets, targetDraft)
    const exc = takeResidual(excludes, excludeDraft)
    const invalid = [...tgt.invalid, ...exc.invalid]
    if (invalid.length > 0) {
      setTargets(tgt.items); setExcludes(exc.items)
      setTargetDraft(tgt.invalid.join(' ')); setExcludeDraft(exc.invalid.join(' '))
      setResidualInvalid(invalid)
      setAdvancedOpen(true)
      return
    }
    setResidualInvalid([])
    setCreateError('')
    createPending.current = true
    setCreating(true)
    try {
      const fromProfile = imported ? profileToInitialConfig(imported) : undefined
      // Typed entries are sent only when there are some: an empty card stays
      // "not decided yet", not an empty scope the operator chose.
      const typed = tgt.items.length > 0 || exc.items.length > 0
      const union = (a: string[] | undefined, b: string[]): string[] => [...(a ?? []), ...b.filter((x) => !(a ?? []).includes(x))]
      const initialConfig = typed
        ? {
            ...fromProfile,
            scope: {
              ...fromProfile?.scope,
              targets: union(fromProfile?.scope.targets, tgt.items),
              excludeTargets: union(fromProfile?.scope.excludeTargets, exc.items)
            }
          }
        : fromProfile
      const project = await window.redlog.project.create(trimmed, initialConfig)
      onCreated({ id: project.id, name: project.name })
    } catch (e) {
      setCreateError(String((e as Error)?.message ?? e))
      createPending.current = false
      setCreating(false)
      toast(t('project.openFailedTitle'), { type: 'error', why: t('project.openFailedWhy'), detail: String((e as Error)?.message ?? e) })
    }
  }

  async function handleImportProfile(): Promise<void> {
    if (importPending.current || createPending.current) return
    importPending.current = true
    setImporting(true)
    try {
      const result = await window.redlog.config.importProfile()
      if (result.status === 'cancelled') return
      if (result.status === 'failed') { setImportFailure(result.failure); return }
      // Replace, never layer: what the file leaves out is the default.
      setImportFailure(null)
      setImported(result.profile)
      toast(t('toast.profileImported'), 'success')
    } catch (e) {
      setImportFailure({ code: 'read', detail: String((e as Error)?.message ?? e) })
    } finally {
      importPending.current = false
      setImporting(false)
    }
  }

  const appliedText = imported
    ? profileSummary(imported).map((p) => t(p.key, { count: p.count ?? 0 })).join(' · ') || t('project.appliedNothing')
    : null
  const failureText = importFailure ? describeFailure(importFailure, t) : null
  const ruleCount = targets.length + (imported ? profileToInitialConfig(imported).scope.targets.length : 0)
  const summary = ruleCount > 0 ? t('project.advancedSet', { count: ruleCount }) : t('project.scope.unset')

  return (
    <Modal open={open} onClose={close} label={t('project.newTitle')} initialFocus={nameInput}
      panelClassName="w-full max-w-xl m-4 flex max-h-[calc(92vh/var(--app-zoom,0.9))] flex-col rounded-xl border border-redlog-border-subtle bg-redlog-surface shadow-2xl">
      <form data-testid="create-project-form" onSubmit={(e) => { e.preventDefault(); void handleCreate() }} className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-redlog-border-subtle px-6 py-4">
          <div>
            <h2 id={titleId} className="text-sm font-semibold tracking-wider text-redlog-text">{t('project.newTitle')}</h2>
            <p className="mt-0.5 text-xs text-redlog-text-dim">{t('project.newSubtitle')}</p>
          </div>
          <button type="button" data-testid="create-project-close" aria-label={t('common.close')} disabled={busy} onClick={close}
            className="rounded-lg p-1 text-redlog-text-dim hover:bg-redlog-elevated hover:text-redlog-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-redlog-accent/40">
            <X size={18} aria-hidden />
          </button>
        </div>

        <div data-testid="create-project-body" className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5 text-xs">
          <label className="block text-xs font-medium text-redlog-text">
            {t('project.name')} <span aria-hidden className="text-redlog-accent">*</span>
            <input ref={nameInput} aria-required aria-invalid={nameMissing || undefined} value={name} disabled={busy}
              onChange={(e) => { setName(e.target.value); if (e.target.value.trim()) setNameMissing(false) }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void handleCreate() } }}
              placeholder={t('project.placeholder')}
              className="mt-1.5 block w-full rounded-lg border border-redlog-border bg-redlog-bg px-3.5 py-2 font-mono text-xs text-redlog-text focus:outline-none focus:ring-2 focus:ring-redlog-accent/40" />
          </label>
          {nameMissing && <p role="alert" data-testid="create-project-name-missing" className="-mt-3 text-xs text-red-300">{t('project.nameRequired')}</p>}

          {root && (
            <div>
              <p className="mb-1.5 text-xs text-redlog-text-dim">{t('project.storageLabel')}</p>
              <div data-testid="create-project-root" className="flex items-center gap-2 rounded-lg border border-redlog-border bg-redlog-bg px-3.5 py-2 font-mono text-xs text-redlog-text-dim">
                <FolderOpen size={14} aria-hidden className="shrink-0" />
                <span className="truncate" title={root}>{root}</span>
              </div>
              <p className="mt-1 text-xs text-redlog-text-faint">{t('project.storageFolderNote')}</p>
            </div>
          )}

          <div className="overflow-hidden rounded-lg border border-redlog-border bg-redlog-elevated/40">
            <button type="button" data-testid="create-project-advanced" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((v) => !v)}
              className="flex w-full items-center justify-between gap-2 px-3.5 py-3 text-left hover:bg-redlog-elevated">
              <span className="flex items-center gap-2 text-xs font-semibold text-redlog-text">
                <ChevronRight size={14} aria-hidden className={`transition-transform ${advancedOpen ? 'rotate-90' : ''}`} />
                {t('project.advanced')}
              </span>
              <span data-testid="create-project-advanced-summary" className="rounded border border-redlog-border bg-redlog-elevated px-2 py-0.5 font-mono text-xs text-redlog-text-dim">{summary}</span>
            </button>
            {advancedOpen && (
              <div className="space-y-5 border-t border-redlog-border bg-redlog-surface p-4">
                <p className="rounded border border-redlog-border-subtle bg-redlog-bg p-2.5 text-xs leading-relaxed text-redlog-text-dim">{t('project.scopeNotBlocking')}</p>
                <ListField label={t('project.targetsLabel')} items={targets} onChange={setTargets} placeholder={t('settings.targetsPlaceholder')} parse={parseScopeInput}
                  draft={targetDraft} onDraftChange={setTargetDraft} />
                <ListField label={t('project.excludeLabel')} items={excludes} onChange={setExcludes} placeholder={t('settings.excludePlaceholder')} parse={parseScopeInput}
                  draft={excludeDraft} onDraftChange={setExcludeDraft} />
                {residualInvalid.length > 0 && (
                  <p role="alert" data-testid="create-project-residual" className="text-xs text-red-300">{t('project.residualInvalid', { entries: residualInvalid.join(' ') })}</p>
                )}
                <div className="border-t border-redlog-border-subtle pt-2">
                  <div className="relative my-2 flex items-center justify-center">
                    <span className="absolute inset-x-0 h-px bg-redlog-border" />
                    <span className="relative bg-redlog-surface px-3 text-xs text-redlog-text-faint">{t('project.or')}</span>
                  </div>
                  <button type="button" disabled={busy} onClick={() => void handleImportProfile()}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-redlog-border py-2 text-xs text-redlog-text-dim hover:border-redlog-text-faint hover:text-redlog-text disabled:opacity-50">
                    <Upload size={14} aria-hidden />{t('project.importProfile')}
                  </button>
                  {appliedText && <div className="mt-2 flex items-center gap-2"><p data-testid="profile-applied" className="text-xs text-redlog-text-dim">{appliedText}</p>
                    <Button type="button" level="quiet" disabled={busy} onClick={() => { setImported(null); setImportFailure(null) }}>{t('project.clearImported')}</Button></div>}
                  {failureText && <p role="alert" data-testid="profile-error" className="mt-2 text-xs text-red-300">{failureText}</p>}
                </div>
              </div>
            )}
          </div>
          {createError && <p role="alert" className="text-xs text-red-300">{createError}</p>}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-redlog-border-subtle bg-redlog-elevated/40 px-6 py-3.5">
          <Button type="button" level="secondary" disabled={busy} onClick={close}>{t('common.cancel')}</Button>
          <Button level="primary" type="submit" data-testid="create-project-submit" disabled={busy}>{t('project.create')}</Button>
        </div>
      </form>
    </Modal>
  )
}
