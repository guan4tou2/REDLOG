import { useRef, useState } from 'react'
import { matchesQuery } from '../lib/textQuery'
import { SectionLabel } from './SectionLabel'
import { useI18n } from '../i18n'
import { formatFreshness, formatDate, formatSize } from '../lib/time'
import { confirmChainImpact } from './ConfirmDialog'
import { Wordmark } from './Wordmark'
import { toast } from './Toast'
import { Button } from './Button'
import { Modal } from './Modal'
import { ListField } from './settings/SettingsShared'
import { parseScopeInput } from '../lib/scopeInput'
import { useReadState } from '../lib/readState'
import { profileSummary, profileToInitialConfig, type ImportedProfile, type ProfileFailure } from '../../../core/profile-import'

/** Spec 068 D1: the search box appears from this many projects. */
const SEARCH_MIN_PROJECTS = 6

type Translate = (key: string, vars?: Record<string, string | number>) => string

/** What the picker shows for one project's scope (Spec 068 US2). `undefined`
 *  means the answer has not arrived: the badge is BLANK then, never "not set".
 *  "Not set" is a hint (the amber the issue list uses for pending things), not
 *  the red of an alarm — an empty scope is a normal state at project start.
 *  Declared at module scope: a component defined inside ProjectPicker would
 *  remount every row on every keystroke in the search box. */
function ScopeBadge({ summary, t }: { summary: ProjectScopeSummary | undefined; t: Translate }): JSX.Element | null {
  if (!summary) return null
  const base = 'shrink-0 rounded border px-2 py-0.5 text-xs font-mono'
  if (summary.state === 'set') {
    return <span data-testid="project-scope-badge" data-state="set" className={`${base} border-redlog-border text-redlog-text-dim`}>{t(summary.count === 1 ? 'project.scope.one' : 'project.scope.many', { count: summary.count })}</span>
  }
  if (summary.state === 'unset') {
    return <span data-testid="project-scope-badge" data-state="unset" title={t('project.scope.unsetWhy')} className={`${base} border-amber-900/60 text-amber-300`}>{t('project.scope.unset')}</span>
  }
  return <span data-testid="project-scope-badge" data-state="unknown" title={t('project.scope.unknownWhy')} className={`${base} border-redlog-border text-redlog-text-faint`}>{t('project.scope.unknown')}</span>
}

/** One entry of the query answer, trusted only if it is one of the three
 *  states. Anything else (a stale preload, a bad entry) is "unknown" — it must
 *  not read as "not set". */
function summaryFor(answer: Record<string, ProjectScopeSummary> | null, id: string): ProjectScopeSummary {
  const s = answer?.[id]
  if (s?.state === 'set' && Number.isInteger(s.count) && s.count > 0) return s
  if (s?.state === 'unset') return s
  return { state: 'unknown' }
}

interface ProjectPickerProps {
  onProjectOpen: (project: { id: string; name: string }) => void
}

export default function ProjectPicker({ onProjectOpen }: ProjectPickerProps): JSX.Element {
  // The list is a read that can be pending, empty, or fail — three different
  // screens (#298). `projects` is what is known; `listRead.phase` says how far
  // to trust it. A failed refresh keeps the last known list.
  // The whole UI runs on the preload bridge. If it's missing (e.g. the page was
  // opened in a plain browser instead of the RedLog app), every button silently
  // no-ops — so detect it and say so instead of dying quietly.
  const bridgeMissing = typeof window.redlog === 'undefined'
  const { state: listRead, retry: retryList, update: updateList } = useReadState(
    () => window.redlog.project.list(),
    !bridgeMissing
  )
  const projects: ProjectMeta[] = listRead.value ?? []
  // Scope badges. A separate read that starts once the list has answered
  // (loaded or failed) so it can never delay the first paint of the list
  // (FR-018). Each (re)read of the list is a new generation: useReadState drops
  // an answer that arrives after the next read began, so a late reply cannot
  // land on a list it was not asked about. Answers are looked up by project id.
  const { state: scopeRead } = useReadState(
    () => window.redlog.project.scopeSummaries(),
    !bridgeMissing && listRead.phase !== 'loading',
    [listRead.phase]
  )
  const scopeFor = (id: string): ProjectScopeSummary | undefined =>
    scopeRead.phase === 'loaded' ? summaryFor(scopeRead.value, id)
    : scopeRead.phase === 'failed' ? { state: 'unknown' }
    : undefined
  const setProjects = (fn: (prev: ProjectMeta[]) => ProjectMeta[]): void => updateList((prev) => fn(prev ?? []))
  const [createOpen, setCreateOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [opening, setOpening] = useState<string | null>(null)
  const openPending = useRef(false)
  const [newName, setNewName] = useState('')
  const [createError, setCreateError] = useState('')
  const [importing, setImporting] = useState(false)
  const importPending = useRef(false)
  const [creating, setCreating] = useState(false)
  const createPending = useRef(false)
  // The safe/exposed IPs and the violation warning are owned by Settings; the
  // create form holds them only when a profile was imported, because an import
  // can carry them into a project that does not exist yet (#297). Scope targets
  // and exclusions can also be typed here (#588).
  // One resolved value: the import summary and the project.create
  // argument are both derived from it, and importing replaces it whole.
  const [imported, setImported] = useState<ImportedProfile | null>(null)
  // Targets typed on the card (#588). They sit beside an imported profile and
  // are added to what it carries, so importing never discards what was typed.
  const [scopeTargets, setScopeTargets] = useState<string[]>([])
  const [scopeExcludes, setScopeExcludes] = useState<string[]>([])
  // A refused file leaves `imported` as it was; this says why.
  const [importFailure, setImportFailure] = useState<ProfileFailure | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const { t } = useI18n()

  async function handleRenameCommit(id: string): Promise<void> {
    const name = renameValue.trim()
    setRenamingId(null)
    if (!name) return
    const orig = projects.find((p) => p.id === id)?.name
    if (name === orig) return
    const res = await window.redlog.project.rename(id, name)
    if (res.ok) setProjects((prev) => prev.map((p) => p.id === id ? { ...p, name: res.name ?? name } : p))
    // A refused rename used to leave the old name on screen with no word about
    // it: the row simply snapped back and the operator tried again.
    else toast(t('project.renameFailed'), { type: 'error', why: res.error })
  }

  async function handleCreate(): Promise<void> {
    const name = newName.trim()
    if (!name || createPending.current || importPending.current) return
    setCreateError('')
    createPending.current = true
    setCreating(true)
    try {
      // An imported profile or typed scope entries put something here;
      // Settings ▸ Scope still owns everything else. For a profile, whether
      // one was imported is the question, not what it holds — `false` and an
      // empty list are settings too.
      const fromProfile = imported ? profileToInitialConfig(imported) : undefined
      // Typed entries are sent only when there are some: an empty card must
      // stay "not decided yet", not become an empty scope the operator chose.
      const typed = scopeTargets.length > 0 || scopeExcludes.length > 0
      const union = (a: string[] | undefined, b: string[]): string[] => [...(a ?? []), ...b.filter((x) => !(a ?? []).includes(x))]
      const initialConfig = typed
        ? {
            ...fromProfile,
            scope: {
              ...fromProfile?.scope,
              targets: union(fromProfile?.scope.targets, scopeTargets),
              excludeTargets: union(fromProfile?.scope.excludeTargets, scopeExcludes)
            }
          }
        : fromProfile
      const project = await window.redlog.project.create(name, initialConfig)
      onProjectOpen({ id: project.id, name: project.name })
    } catch (e) {
      setCreateError(String((e as Error)?.message ?? e))
      createPending.current = false
      setCreating(false)
      toast(t('project.openFailedTitle'), {
        type: 'error',
        why: t('project.openFailedWhy'),
        detail: String((e as Error)?.message ?? e)
      })
    }
  }

  async function handleOpen(id: string): Promise<void> {
    if (openPending.current || createPending.current) return
    openPending.current = true
    setOpening(id)
    try {
      const project = await window.redlog.project.open(id)
      if (project) onProjectOpen({ id: project.id, name: project.name })
      else toast(t('project.openMissing'), { type: 'error', why: t('project.openMissingWhy') })
    } catch (e) {
      toast(t('project.openFailedTitle'), {
        type: 'error',
        why: t('project.openFailedWhy'),
        detail: String((e as Error)?.message ?? e)
      })
    } finally {
      openPending.current = false
      setOpening(null)
    }
  }

  async function handleDelete(id: string): Promise<void> {
    const project = projects.find((p) => p.id === id)
    if (!project) return
    // §5.5 level 3. This is the single most consequential action in the app —
    // it destroys the SHA-256 chain, the screenshots, the session recordings
    // and the OpenTimestamps receipts, and the receipts in particular cannot
    // be regenerated at any price, because they attest to a moment that has
    // passed. It was running on the same checkbox as removing a shell hook.
    const ok = await confirmChainImpact({
      title: t('confirm.deleteProject'),
      message: t('confirm.deleteProjectDesc', { name: project.name }),
      confirmLabel: t('confirm.deleteProjectConfirm'),
      consequences: [
        t('confirm.deleteProjectChain'),
        t('confirm.deleteProjectMedia'),
        t('confirm.deleteProjectAnchors')
      ],
      requireTyped: project.name
    })
    if (!ok) return
    await window.redlog.project.delete(id)
    setProjects((prev) => prev.filter((p) => p.id !== id))
  }

  async function handleImportProfile(): Promise<void> {
    if (importPending.current || createPending.current) return
    importPending.current = true
    setImporting(true)
    try {
      const result = await window.redlog.config.importProfile()
      // Backing out of the picker is not an error and changes nothing.
      if (result.status === 'cancelled') return
      if (result.status === 'failed') {
        // The earlier import, if any, stays exactly as it was.
        setImportFailure(result.failure)
        return
      }
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

  function handleClearImported(): void {
    setImported(null)
    setImportFailure(null)
  }

  const failureText = importFailure ? describeFailure(importFailure) : null
  function describeFailure(f: ProfileFailure): string {
    switch (f.code) {
      case 'read': return t('project.importFailedRead', { detail: f.detail })
      case 'parse': return t('project.importFailedParse', { detail: f.detail })
      case 'empty': return t('project.importFailedEmpty')
      case 'shape': return t('project.importFailedShape', { field: f.field, expected: t(`project.expect.${f.expected}`) })
    }
  }
  // Nothing a profile carries is visible on this form, so all of it is named
  // here or it is applied in silence.
  const appliedText = imported
    ? profileSummary(imported).map((p) => t(p.key, { count: p.count ?? 0 })).join(' · ') || t('project.appliedNothing')
    : null

  const nameInput = useRef<HTMLInputElement | null>(null)
  const hasRecent = projects.length > 0
  // Spec 068 D1: the box exists once there are enough projects to need it, judged
  // on the UNFILTERED total. A query typed before deletions brought the total
  // under the threshold must not keep filtering with no box to clear it.
  const searchVisible = projects.length >= SEARCH_MIN_PROJECTS
  const query = searchVisible ? search : ''
  const filtered = projects.filter(p => matchesQuery(p.name, query))
  const searching = query.trim() !== ''
  // D3: Enter opens a project only when the query is non-blank and names exactly
  // one. Several matches or none leave the query and the focus where they are.
  // An Enter that confirms an input-method composition is not an Enter.
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return
    e.preventDefault()
    if (searching && filtered.length === 1) void handleOpen(filtered[0].id)
  }
  const nameCounts = new Map<string, number>()
  for (const p of projects) nameCounts.set(p.name, (nameCounts.get(p.name) ?? 0) + 1)
  const listStatus: 'loading' | 'empty' | 'failed' | null = bridgeMissing ? null
    : listRead.phase === 'failed' ? 'failed'
    : listRead.phase === 'loading' ? (hasRecent ? null : 'loading')
    : hasRecent ? null : 'empty'
  // bg-redlog-bg, not the literal #0a0a0a this used to hardcode: the token moved
  // to #121214 when the palette got its cool cast, and the mark's cut corners are
  // transparent now, so the picker showing a different window colour from the
  // title bar is something you can actually see.
  return (
    <div className="h-full flex flex-col bg-redlog-bg text-redlog-text" data-testid="project-picker">
      <div inert={createOpen} className="flex-1 min-h-0 flex flex-col">
      {/* Draggable title bar zone */}
      <div
        className="h-10 shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      />
      <div className="flex-1 overflow-y-auto px-4 py-10 flex flex-col" style={{ justifyContent: 'safe center' }}>
      <div className="shrink-0 mb-8 text-center"><Wordmark className="text-4xl" /></div>
      <div className="w-full max-w-[740px] mx-auto space-y-4 bg-redlog-surface border border-redlog-border-subtle rounded-xl p-6 shadow-2xl">
        {bridgeMissing && <p role="alert" className="text-red-300 text-xs">{t('project.bridgeMissing')}</p>}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-redlog-border-subtle">
          <div className="flex items-center gap-2.5"><SectionLabel>{t('project.recent')}</SectionLabel><span data-testid="project-search-count" role="status" className="px-2 py-0.5 text-xs font-mono rounded bg-redlog-elevated border border-redlog-border">{searching ? `${filtered.length} / ${projects.length}` : filtered.length}</span></div>
          <Button level="secondary" disabled={bridgeMissing || !!opening} onClick={() => setCreateOpen(true)}>{t('project.new')}</Button>
        </div>
        {searchVisible && <input type="search" aria-label={t('project.search')} placeholder={t('project.search')} value={search} onChange={e => setSearch(e.target.value)} onKeyDown={onSearchKeyDown} className="w-full bg-redlog-bg border border-redlog-border-subtle rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-redlog-accent/40" />}
        <div className="space-y-1.5 max-h-[380px] overflow-y-auto pr-1" aria-busy={!!opening} onKeyDown={e => {
          if (!(e.target instanceof HTMLElement) || !e.target.matches('[data-project-open]') || !['ArrowUp', 'ArrowDown'].includes(e.key)) return
          const rows = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-project-open]'))
          const index = rows.indexOf(e.target as HTMLButtonElement)
          e.preventDefault()
          rows[(index + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus()
        }}>
          {filtered.map(p => <div key={p.id} className="flex items-center gap-2 rounded-lg border border-transparent px-3 py-3 hover:bg-redlog-elevated-hover hover:border-redlog-border-subtle focus-within:bg-[#161b22] focus-within:border-redlog-border group">
            {renamingId === p.id ? <input autoFocus aria-label={t('project.rename')} value={renameValue} onChange={e => setRenameValue(e.target.value)} onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); void handleRenameCommit(p.id) }
              if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null) }
            }} onBlur={() => void handleRenameCommit(p.id)} className="flex-1 min-w-0 bg-redlog-surface border border-redlog-border rounded px-2 py-1" /> :
            <button data-project-open type="button" disabled={!!opening} aria-label={p.name} onClick={() => void handleOpen(p.id)} className="min-w-0 flex-1 text-left rounded py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-redlog-accent/40 disabled:opacity-60">
              <span title={p.name} className="block truncate text-sm text-redlog-text">{p.name}</span>
              <span className="block text-xs text-redlog-text-faint font-mono">{opening === p.id ? t('project.opening') : formatFreshness(p.lastOpened, t)} · {t('project.created', { date: formatDate(p.createdAt) })}</span>
              {(nameCounts.get(p.name) ?? 0) > 1 && <span className="block break-all text-xs text-redlog-text-dim font-mono">{p.path}</span>}
            </button>}
            <ScopeBadge summary={scopeFor(p.id)} t={t} />
            <span className="shrink-0 text-xs font-mono text-redlog-text-dim">{p.dbSize != null ? formatSize(p.dbSize) : '—'}</span>
            <button disabled={!!opening} onClick={() => { setRenamingId(p.id); setRenameValue(p.name) }} aria-label={t('project.rename')} className="p-2 text-redlog-muted hover:text-redlog-text focus-visible:ring-2 focus-visible:ring-redlog-accent/40">✎</button>
            <button disabled={!!opening} onClick={() => void handleDelete(p.id)} aria-label={t('project.delete')} className="p-2 text-redlog-muted hover:text-red-400 focus-visible:ring-2 focus-visible:ring-redlog-accent/40">✕</button>
          </div>)}
        </div>
        {hasRecent && filtered.length === 0 && (
          <div className="py-8 text-center space-y-2">
            <p role="status" className="text-xs text-redlog-text-faint">{t('project.noResults')}</p>
            {searching && <Button level="quiet" type="button" data-testid="project-search-clear" onClick={() => setSearch('')}>{t('project.clearSearch')}</Button>}
          </div>
        )}

        {listStatus === 'loading' && (
          <p data-testid="project-list-status" data-state="loading" role="status" className="text-center text-xs text-redlog-text-faint font-mono">
            {t('project.listLoading')}
          </p>
        )}
        {listStatus === 'empty' && (
          <p data-testid="project-list-status" data-state="empty" className="text-center text-xs text-redlog-text-faint font-mono">
            {t('project.listEmpty')}
          </p>
        )}
        {listStatus === 'failed' && listRead.phase === 'failed' && (
          <div data-testid="project-list-status" data-state="failed" role="alert" className="rounded-xl border border-red-900/50 bg-red-950/40 p-4 text-center">
            <p className="text-red-300 text-xs">{t('project.listFailed')}</p>
            <p className="mt-1 truncate font-mono text-xs text-redlog-text-faint" title={listRead.error}>{listRead.error}</p>
            <Button level="quiet" onClick={retryList} className="mt-2 text-xs">
              {t('common.retry')}
            </Button>
          </div>
        )}

        <div className="pt-4 border-t border-redlog-border-subtle text-xs text-redlog-text-dim font-mono text-right">{t('project.keyboardHint')}</div>
      </div>
      </div>
      </div>
      <Modal open={createOpen} onClose={() => { if (!creating && !importing) setCreateOpen(false) }} label={t('project.new')} initialFocus={nameInput} panelClassName="w-full max-w-[560px] max-h-[calc(90vh/var(--app-zoom,0.9))] overflow-y-auto m-4 p-6 rounded-xl bg-redlog-surface border border-redlog-border-subtle shadow-2xl">
        <form onSubmit={e => { e.preventDefault(); void handleCreate() }} className="space-y-4">
          <h2 className="text-sm font-medium pb-4 border-b border-redlog-border-subtle">{t('project.new')}</h2>
          <label className="block text-xs text-redlog-text-dim">{t('project.name')}
            <input ref={nameInput} value={newName} disabled={creating || importing} onChange={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void handleCreate() } }} placeholder={t('project.placeholder')} className="block mt-1 w-full rounded-lg border border-redlog-border bg-redlog-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-redlog-accent/40" />
          </label>
          <div>
            <ListField label={t('settings.targetsLabel')} items={scopeTargets} onChange={setScopeTargets} placeholder={t('settings.targetsPlaceholder')} parse={parseScopeInput} />
            <p className="text-xs text-redlog-text-faint mt-1">{t('project.scopeHint')}</p>
          </div>
          <details className="text-xs">
            <summary className="cursor-pointer text-redlog-text-dim">{t('project.scopeAdvanced')}</summary>
            <div className="pt-2"><ListField label={t('settings.excludeLabel')} items={scopeExcludes} onChange={setScopeExcludes} placeholder={t('settings.excludePlaceholder')} parse={parseScopeInput} /></div>
          </details>
          <Button type="button" level="quiet" disabled={creating || importing} onClick={() => void handleImportProfile()} className="text-xs">{t('project.importProfile')}</Button>
          {appliedText && <div className="flex gap-2 items-center"><p data-testid="profile-applied" className="text-xs text-redlog-text-dim">{appliedText}</p><Button type="button" level="quiet" disabled={creating || importing} onClick={handleClearImported}>{t('project.clearImported')}</Button></div>}
          {failureText && <p role="alert" data-testid="profile-error" className="text-xs text-red-300">{failureText}</p>}
          {createError && <p role="alert" className="text-xs text-red-300">{createError}</p>}
          <div className="flex justify-end gap-2 pt-4 border-t border-redlog-border-subtle"><Button type="button" level="quiet" disabled={creating || importing} onClick={() => setCreateOpen(false)}>{t('common.cancel')}</Button><Button level="primary" type="submit" disabled={creating || importing || !newName.trim()}>{t('project.create')}</Button></div>
        </form>
      </Modal>
    </div>
  )
}


