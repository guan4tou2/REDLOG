import { useEffect, useRef, useState } from 'react'
import { Plus, Search } from 'lucide-react'
import { matchesQuery } from '../lib/textQuery'
import { SectionLabel } from './SectionLabel'
import { useI18n } from '../i18n'
import { formatFreshness, formatDate, formatSize } from '../lib/time'
import { confirmChainImpact } from './ConfirmDialog'
import { Wordmark } from './Wordmark'
import { toast } from './Toast'
import { Button } from './Button'
import { useReadState } from '../lib/readState'
import { CreateProjectModal } from './CreateProjectModal'

type Translate = (key: string, vars?: Record<string, string | number>) => string

/** What the picker shows for one project's scope (Spec 068 US2). `undefined`
 *  means the answer has not arrived: the badge is BLANK then, never "not set".
 *  "Not set" is a neutral fact, not an alarm — an empty scope is a normal state
 *  at project start (Stitch 01 draws it in the same grey as the count).
 *  Declared at module scope: a component defined inside ProjectPicker would
 *  remount every row on every keystroke in the search box. */
function ScopeBadge({ summary, t }: { summary: ProjectScopeSummary | undefined; t: Translate }): JSX.Element | null {
  if (!summary) return null
  const base = 'shrink-0 rounded border px-1.5 py-0.5 text-xs font-mono'
  if (summary.state === 'set') {
    return <span data-testid="project-scope-badge" data-state="set" className={`${base} border-redlog-border text-redlog-text-dim`}>{t(summary.count === 1 ? 'project.scope.one' : 'project.scope.many', { count: summary.count })}</span>
  }
  if (summary.state === 'unset') {
    return <span data-testid="project-scope-badge" data-state="unset" title={t('project.scope.unsetWhy')} className={`${base} border-redlog-border bg-redlog-elevated text-redlog-text-dim`}>{t('project.scope.unset')}</span>
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

function Kbd({ children }: { children: React.ReactNode }): JSX.Element {
  return <kbd className="rounded border border-redlog-border bg-redlog-elevated px-1.5 py-0.5 font-mono text-xs text-redlog-text-dim">{children}</kbd>
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
  // (FR-018). Answers are looked up by project id.
  const { state: scopeRead } = useReadState(
    () => window.redlog.project.scopeSummaries(),
    !bridgeMissing && listRead.phase !== 'loading',
    [listRead.phase]
  )
  // Where projects live. Optional: an older main without the call, or a
  // failed read, simply leaves the line out.
  const { state: rootRead } = useReadState(
    async () => (typeof window.redlog.project.root === 'function' ? await window.redlog.project.root() : null),
    !bridgeMissing
  )
  const root = rootRead.phase === 'loaded' && typeof rootRead.value === 'string' ? rootRead.value : null
  const scopeFor = (id: string): ProjectScopeSummary | undefined =>
    scopeRead.phase === 'loaded' ? summaryFor(scopeRead.value, id)
    : scopeRead.phase === 'failed' ? { state: 'unknown' }
    : undefined
  const setProjects = (fn: (prev: ProjectMeta[]) => ProjectMeta[]): void => updateList((prev) => fn(prev ?? []))
  const [createOpen, setCreateOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const openPending = useRef(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)
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

  async function handleOpen(id: string): Promise<void> {
    if (openPending.current) return
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
    // §5.5 level 3. This destroys the SHA-256 chain, the screenshots, the
    // session recordings and the OpenTimestamps receipts, and the receipts in
    // particular cannot be regenerated at any price.
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

  const hasRecent = projects.length > 0
  const filtered = projects.filter(p => matchesQuery(p.name, search))
  const searching = search.trim() !== ''
  // Stitch 01: one row is always selected — the first match unless the
  // operator moved it — and Enter opens the selected row, from the list or
  // from the search box. A click selects; a double click opens.
  const selected = filtered.find((p) => p.id === selectedId) ?? filtered[0] ?? null
  const selectedIndex = selected ? filtered.indexOf(selected) : -1
  const move = (step: number): void => {
    if (filtered.length === 0) return
    const next = filtered[(selectedIndex + step + filtered.length) % filtered.length]
    setSelectedId(next.id)
    listRef.current?.querySelector<HTMLElement>(`[data-project-row="${CSS.escape(next.id)}"]`)?.focus()
  }
  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    // Rename and the row's own buttons keep their keys.
    if (e.target instanceof HTMLInputElement || (e.target instanceof HTMLButtonElement && !e.target.hasAttribute('data-project-row'))) return
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
    else if (e.key === 'Enter' && selected) { e.preventDefault(); void handleOpen(selected.id) }
  }
  // In the search box the arrows stay with the text. Enter opens the selected
  // match, never one the operator cannot see; an Enter that confirms an
  // input-method composition is not an Enter.
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return
    e.preventDefault()
    if (selected) void handleOpen(selected.id)
  }
  const nameCounts = new Map<string, number>()
  for (const p of projects) nameCounts.set(p.name, (nameCounts.get(p.name) ?? 0) + 1)
  const listStatus: 'loading' | 'empty' | 'failed' | null = bridgeMissing ? null
    : listRead.phase === 'failed' ? 'failed'
    : listRead.phase === 'loading' ? (hasRecent ? null : 'loading')
    : hasRecent ? null : 'empty'
  // A query that no longer matches the selected row moves the selection to the
  // first match, so the highlight is always on something Enter would open.
  useEffect(() => { if (selectedId && !filtered.some((p) => p.id === selectedId)) setSelectedId(null) }, [search]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="h-full flex flex-col bg-redlog-bg text-redlog-text" data-testid="project-picker">
      <div inert={createOpen} className="flex-1 min-h-0 flex flex-col">
      {/* Draggable title bar zone */}
      <div
        className="h-10 shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      />
      <div className="flex-1 overflow-y-auto px-4 py-10 flex flex-col" style={{ justifyContent: 'safe center' }}>
      <div className="shrink-0 mb-8 text-center select-none">
        <Wordmark className="text-4xl" />
        <p className="mt-1.5 font-mono text-xs tracking-[0.25em] text-redlog-text-dim">{t('project.tagline')}</p>
      </div>
      <div className="w-full max-w-[740px] mx-auto bg-redlog-surface border border-redlog-border-subtle rounded-xl p-6 shadow-2xl flex flex-col">
        {bridgeMissing && <p role="alert" className="mb-3 text-red-300 text-xs">{t('project.bridgeMissing')}</p>}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 mb-4 border-b border-redlog-border-subtle">
          <div className="flex items-center gap-2.5"><SectionLabel>{t('project.recent')}</SectionLabel><span data-testid="project-search-count" role="status" className="px-2 py-0.5 text-xs font-mono font-bold rounded bg-redlog-elevated border border-redlog-border">{searching ? `${filtered.length} / ${projects.length}` : filtered.length}</span></div>
          <Button level="primary" data-testid="project-new" disabled={bridgeMissing || !!opening} onClick={() => setCreateOpen(true)}>
            <Plus size={14} strokeWidth={2.5} aria-hidden />{t('project.newTitle')}
          </Button>
        </div>
        <div className="relative mb-4">
          <Search size={16} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-redlog-text-faint" />
          <input type="search" data-testid="project-search" aria-label={t('project.search')} placeholder={t('project.searchPlaceholder')} value={search} onChange={e => setSearch(e.target.value)} onKeyDown={onSearchKeyDown}
            className="w-full bg-redlog-bg border border-redlog-border-subtle rounded-lg pl-9 pr-3.5 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-redlog-accent/40" />
        </div>
        <div ref={listRef} role="listbox" aria-label={t('project.recent')} data-testid="project-list" className="space-y-1.5 max-h-[380px] overflow-y-auto pr-1 py-1" aria-busy={!!opening} onKeyDown={onListKeyDown}>
          {filtered.map(p => {
            const isSel = selected?.id === p.id
            return <div key={p.id} role="option" aria-selected={isSel} data-testid="project-row" data-selected={isSel || undefined}
              onClick={() => setSelectedId(p.id)} onDoubleClick={() => void handleOpen(p.id)}
              className={`group flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 transition-colors ${isSel ? 'bg-redlog-elevated border-redlog-border' : 'border-transparent hover:bg-redlog-elevated/60 hover:border-redlog-border-subtle'}`}>
            <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${isSel ? 'bg-redlog-accent' : 'bg-redlog-accent/60 group-hover:bg-redlog-accent'}`} />
            {renamingId === p.id ? <input autoFocus aria-label={t('project.rename')} value={renameValue} onChange={e => setRenameValue(e.target.value)} onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); void handleRenameCommit(p.id) }
              if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null) }
            }} onBlur={() => void handleRenameCommit(p.id)} className="flex-1 min-w-0 bg-redlog-surface border border-redlog-border rounded px-2 py-1" /> :
            <button data-project-row={p.id} data-project-open type="button" disabled={!!opening} aria-label={p.name} tabIndex={isSel ? 0 : -1}
              onFocus={() => setSelectedId(p.id)} title={t('project.openHint')}
              className="min-w-0 flex-1 text-left rounded py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-redlog-accent/40 disabled:opacity-60">
              <span className="flex min-w-0 items-center gap-2">
                <span title={p.name} className="truncate font-mono text-xs font-medium text-redlog-text">{p.name}</span>
                <ScopeBadge summary={scopeFor(p.id)} t={t} />
              </span>
              <span className="mt-0.5 block font-mono text-xs text-redlog-text-faint">{opening === p.id ? t('project.opening') : formatFreshness(p.lastOpened, t)} · {t('project.created', { date: formatDate(p.createdAt) })}</span>
              {(nameCounts.get(p.name) ?? 0) > 1 && <span className="block break-all text-xs text-redlog-text-dim font-mono">{p.path}</span>}
            </button>}
            <span className="shrink-0 text-right font-mono text-xs text-redlog-text-dim">{p.dbSize != null ? formatSize(p.dbSize) : '—'}</span>
            <span className={`flex shrink-0 items-center ${isSel ? '' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'}`}>
              <button disabled={!!opening} onClick={(e) => { e.stopPropagation(); setRenamingId(p.id); setRenameValue(p.name) }} onDoubleClick={e => e.stopPropagation()} aria-label={t('project.rename')} className="p-2 text-redlog-muted hover:text-redlog-text focus-visible:ring-2 focus-visible:ring-redlog-accent/40">✎</button>
              <button disabled={!!opening} onClick={(e) => { e.stopPropagation(); void handleDelete(p.id) }} onDoubleClick={e => e.stopPropagation()} aria-label={t('project.delete')} className="p-2 text-redlog-muted hover:text-red-400 focus-visible:ring-2 focus-visible:ring-redlog-accent/40">✕</button>
            </span>
          </div>
          })}
        </div>
        {hasRecent && filtered.length === 0 && (
          <div className="py-8 text-center space-y-2">
            <p role="status" className="font-mono text-xs text-redlog-text-faint">{searching ? t('project.noResultsFor', { query: search.trim() }) : t('project.noResults')}</p>
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

        <div data-testid="project-picker-footer" className="mt-4 pt-4 border-t border-redlog-border-subtle flex flex-wrap items-center justify-between gap-2 font-mono text-xs text-redlog-text-faint">
          <span className="min-w-0 truncate" title={root ?? undefined}>{root && <>{t('project.storageDir')}<span title={root} className="text-redlog-text-dim">{root}</span></>}</span>
          <span className="flex items-center gap-3 whitespace-nowrap">
            <span>{t('project.keyPress')} <Kbd>↑</Kbd><Kbd>↓</Kbd> {t('project.keyBrowse')}</span>
            <span>{t('project.keyPress')} <Kbd>Enter</Kbd> {t('project.keyOpen')}</span>
          </span>
        </div>
      </div>
      </div>
      <footer className="shrink-0 border-t border-redlog-border-subtle/60 py-4 text-center font-mono text-xs text-redlog-text-faint">{t('project.pageFooter')}</footer>
      </div>
      <CreateProjectModal open={createOpen} root={root} onClose={() => setCreateOpen(false)} onCreated={onProjectOpen} />
    </div>
  )
}
