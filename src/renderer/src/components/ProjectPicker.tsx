import { useRef, useState } from 'react'
import { SectionLabel } from './SectionLabel'
import { ChevronRight } from 'lucide-react'
import { useI18n } from '../i18n'
import { formatFreshness, formatDate, formatSize } from '../lib/time'
import { confirmChainImpact } from './ConfirmDialog'
import { Wordmark } from './Wordmark'
import { toast } from './Toast'
import { Button } from './Button'
import { useReadState } from '../lib/readState'
import { profileSummary, profileToInitialConfig, type ImportedProfile, type ProfileFailure, type ProfileImportResult } from '../../../core/profile-import'

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
  const setProjects = (fn: (prev: ProjectMeta[]) => ProjectMeta[]): void => updateList((prev) => fn(prev ?? []))
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const createPending = useRef(false)
  // Scope, exclusions, the safe/exposed IPs and the violation warning are owned
  // by Settings. The card holds them only when a profile was imported, because
  // an import can carry them into a project that does not exist yet (#297).
  // One resolved value: the summary below the button and the project.create
  // argument are both derived from it, and importing replaces it whole.
  const [imported, setImported] = useState<ImportedProfile | null>(null)
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
  }

  async function handleCreate(): Promise<void> {
    const name = newName.trim()
    if (!name || createPending.current) return
    createPending.current = true
    setCreating(true)
    try {
      // Only an imported profile puts anything here: the card asks for a
      // name, and Settings ▸ Scope owns the rest. Whether one was imported is
      // the question, not what it holds — `false` and an empty list are
      // settings too.
      const initialConfig = imported ? profileToInitialConfig(imported) : undefined
      const project = await window.redlog.project.create(name, initialConfig)
      onProjectOpen({ id: project.id, name: project.name })
    } catch (e) {
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
  // Nothing a profile carries is visible on this card, so all of it is named
  // here or it is applied in silence.
  const appliedText = imported
    ? profileSummary(imported).map((p) => t(p.key, { count: p.count ?? 0 })).join(' · ') || t('project.appliedNothing')
    : null

  // The fixed 480px column left excessive empty
  // gutters on wide displays and cramped-feeling recent-projects rows.
  // Research (JetBrains + Cursor welcome screens, Win32 UX guidance) points
  // at a two-column split above ~800px — brand + new project on the left,
  // recent projects on the right — and a stacked single-column fallback
  // below that so narrow windows behave like the old picker.
  const hasRecent = projects.length > 0
  // What to say about the list itself, if anything. A loaded, non-empty list
  // says nothing; the rows are the answer.
  const listStatus: 'loading' | 'empty' | 'failed' | null = bridgeMissing ? null
    : listRead.phase === 'failed' ? 'failed'
    : listRead.phase === 'loading' ? (hasRecent ? null : 'loading')
    : hasRecent ? null : 'empty'
  // bg-redlog-bg, not the literal #0a0a0a this used to hardcode: the token moved
  // to #121214 when the palette got its cool cast, and the mark's cut corners are
  // transparent now, so the picker showing a different window colour from the
  // title bar is something you can actually see.
  return (
    <div className="h-full flex flex-col bg-redlog-bg" data-testid="project-picker">
      {/* Draggable title bar zone */}
      <div
        className="h-10 shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      />
      {/* The wordmark is pinned, not centred with everything else. Centring
          the whole column meant the identity drifted up and down with the
          window height — the one thing on the screen that should be in the
          same place every time you open the app.
          The cards below it still centre in what is left, and `safe center`
          is what keeps that survivable: `align-items: center` on a scrolling
          box overflows in BOTH directions once the content is taller than the
          box, and the half above the scroll origin cannot be reached. */}
      <div className="shrink-0 pt-10 pb-8 text-center space-y-2">
        <Wordmark className="text-4xl" />
        <p className="text-redlog-text-faint text-xs font-mono">{t('app.subtitle')}</p>
      </div>
      <div
        className="flex-1 flex justify-center px-6 pb-6 overflow-y-auto"
        style={{ alignItems: 'safe center' }}
      >
      <div className={`w-full ${hasRecent ? 'max-w-[880px]' : 'max-w-[480px]'} space-y-6`}>

        {bridgeMissing && (
          <div className="bg-red-950/40 border border-red-900/50 rounded-xl p-4 text-center">
            <p className="text-red-300 text-xs">{t('project.bridgeMissing')}</p>
          </div>
        )}

        {/* Two-column grid at ≥md (768px). Below that the grid collapses to
            one column so the picker on a narrow window looks identical to
            v0.13. When no recent projects exist, the wrapper container also
            drops back to the single-column max-w-[480px] above, so the
            first-launch look stays a centered card rather than a lonely
            new-project card floating in a wide empty gutter. */}
        <div className={`grid gap-6 ${hasRecent ? 'md:grid-cols-2' : 'grid-cols-1'}`}>
        {/* New project */}
        <div className="bg-redlog-surface border border-redlog-border rounded-xl p-5 shadow-card">
          <SectionLabel className="tracking-[0.15em] mb-3">{t('project.new')}</SectionLabel>
          <div className="flex gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              placeholder={t('project.placeholder')}
              autoFocus
              className="flex-1 h-[34px] bg-redlog-bg border border-redlog-border rounded-lg px-3 text-sm text-redlog-text font-mono focus:outline-none focus:border-redlog-accent focus:ring-2 focus:ring-redlog-accent/40 focus:ring-offset-2 focus:ring-offset-redlog-surface placeholder-redlog-muted transition-colors"
            />
            <Button
              level="primary"
              className="shrink-0 whitespace-nowrap"
              onClick={handleCreate}
              disabled={!newName.trim() || creating}
            >
              {t('project.create')}
            </Button>
          </div>

          <Button level="quiet" onClick={handleImportProfile} className="mt-3 text-xs">
            {t('project.importProfile')}
          </Button>
          {appliedText && (
            <div className="mt-1 flex items-center gap-2">
              <p data-testid="profile-applied" className="text-xs text-redlog-text-dim font-mono">{appliedText}</p>
              <Button level="quiet" onClick={handleClearImported} className="text-xs">
                {t('project.clearImported')}
              </Button>
            </div>
          )}
          {failureText && (
            <p role="alert" data-testid="profile-error" className="mt-1 text-xs text-red-300">{failureText}</p>
          )}
        </div>

        {/* Recent projects */}
        {projects.length > 0 && (() => {
          const nameCounts = new Map<string, number>()
          for (const p of projects) nameCounts.set(p.name, (nameCounts.get(p.name) ?? 0) + 1)
          return (
          <div className="bg-redlog-surface border border-redlog-border rounded-xl p-5 shadow-card">
            <SectionLabel className="tracking-[0.15em] mb-3">{t('project.recent')}</SectionLabel>
            <div className="space-y-0.5 max-h-[50vh] overflow-y-auto">
              {projects.map((p) => {
                const isDup = (nameCounts.get(p.name) ?? 0) > 1
                return (
                <div
                  key={p.id}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/[0.03] cursor-pointer group transition-colors"
                  onClick={() => renamingId === p.id ? undefined : handleOpen(p.id)}
                >
                  <div className="w-1.5 h-1.5 rounded-full bg-red-500/40 group-hover:bg-red-500/80 transition-colors shrink-0" />
                  <div className="flex-1 min-w-0">
                    {renamingId === p.id ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); handleRenameCommit(p.id) }
                          if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null) }
                        }}
                        onBlur={() => handleRenameCommit(p.id)}
                        className="w-full bg-redlog-bg border border-redlog-border rounded px-2 py-0.5 text-redlog-text text-xs font-medium font-mono focus:outline-none focus:border-red-500/50"
                      />
                    ) : (
                      <div className="flex items-center gap-2 min-w-0">
                        <span title={p.name} className="text-redlog-text text-xs font-medium truncate">{p.name}</span>
                        {isDup && (
                          <span className="text-redlog-text-faint text-xs font-mono shrink-0">{formatDate(p.createdAt)}</span>
                        )}
                      </div>
                    )}
                    <div className="flex items-center flex-wrap gap-x-2 gap-y-0 text-redlog-text-faint text-xs font-mono">
                      <span className="whitespace-nowrap">{formatFreshness(p.lastOpened, t)}</span>
                      <span className="text-redlog-muted">·</span>
                      <span className="whitespace-nowrap">{t('project.created', { date: formatDate(p.createdAt) })}</span>
                      {p.dbSize != null && p.dbSize > 0 && (
                        <>
                          <span className="text-redlog-muted">·</span>
                          <span className="whitespace-nowrap">{formatSize(p.dbSize)}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); setRenamingId(p.id); setRenameValue(p.name) }}
                    className="text-redlog-muted hover:text-redlog-text focus:text-redlog-text text-xs opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim transition-all px-1"
                    title={t('project.rename')}
                    aria-label={t('project.rename')}
                  >
                    ✎
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(p.id) }}
                    className="text-redlog-muted hover:text-red-400 focus:text-red-400 text-xs opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 transition-all"
                    title={t('project.delete')}
                    aria-label={t('project.delete')}
                  >
                    ✕
                  </button>
                </div>
                )
              })}
            </div>
          </div>
          )
        })()}
        </div>{/* end two-column grid */}

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

      </div>
      </div>
    </div>
  )
}


