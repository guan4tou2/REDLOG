import { useState, useEffect, useRef, useMemo } from 'react'
import { ChevronRight } from 'lucide-react'
import { useI18n } from '../i18n'
import { formatFreshness, formatDate, formatSize } from '../lib/time'
import { confirmChainImpact } from './ConfirmDialog'
import { Wordmark } from './Wordmark'
import { toast } from './Toast'
import { Button } from './Button'
import { IconButton } from './IconButton'

interface ProjectPickerProps {
  onProjectOpen: (project: { id: string; name: string }) => void
}

export default function ProjectPicker({ onProjectOpen }: ProjectPickerProps): JSX.Element {
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  // Spec 037: scope and excludes are pasted on the create card itself. Only
  // the entries the parser accepts are submitted; the rest are listed inline.
  const [scopeTargets, setScopeTargets] = useState<string[]>([])
  const [excludeTargets, setExcludeTargets] = useState<string[]>([])
  // Safe IPs, exposed IPs and the violation warning are owned by Settings
  // (Network and Scope pages). They are held here only because a profile can
  // carry them into a project that does not exist yet.
  const [whitelist, setWhitelist] = useState<string[]>([])
  const [blacklist, setBlacklist] = useState<string[]>([])
  const [warnOnViolation, setWarnOnViolation] = useState(true)
  const [applied, setApplied] = useState<string | null>(null)
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

  // The whole UI runs on the preload bridge. If it's missing (e.g. the page was
  // opened in a plain browser instead of the RedLog app), every button silently
  // no-ops — so detect it and say so instead of dying quietly.
  const bridgeMissing = typeof window.redlog === 'undefined'

  useEffect(() => {
    if (bridgeMissing) return
    window.redlog.project.list().then(setProjects).catch(() => {})
  }, [bridgeMissing])

  async function handleCreate(): Promise<void> {
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    try {
      // Only an imported profile puts anything here now: the card asks for a
      // name, and Settings ▸ Scope owns the rest.
      const carried = scopeTargets.length > 0 || excludeTargets.length > 0 || whitelist.length > 0 || blacklist.length > 0
      const initialConfig = carried
        ? {
          scope: { targets: scopeTargets, excludeTargets, warnOnViolation, scopeFile: null, personalDomains: [] },
          network: { whitelist, blacklist, checkInterval: 60 }
        }
        : undefined
      const project = await window.redlog.project.create(name, initialConfig)
      onProjectOpen({ id: project.id, name: project.name })
    } catch (e) {
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
    const profile = await window.redlog.config.importProfile() as RedLogConfigPartial | null
    if (!profile) return
    if (profile.scope?.targets) setScopeTargets(profile.scope.targets)
    const allow = profile.network?.whitelist
    if (allow) setWhitelist(allow)
    const deny = profile.network?.blacklist
    if (deny) setBlacklist(deny)
    if (profile.scope?.excludeTargets) setExcludeTargets(profile.scope.excludeTargets)
    const warn = profile.scope?.warnOnViolation
    if (warn !== undefined) setWarnOnViolation(warn)
    // Nothing a profile carries is visible on this card, so all of it is named
    // here or it is applied in silence.
    setApplied([
      profile.scope?.targets?.length ? t('project.appliedScope', { count: profile.scope.targets.length }) : null,
      profile.scope?.excludeTargets?.length ? t('project.appliedExcluded', { count: profile.scope.excludeTargets.length }) : null,
      allow?.length ? t('project.appliedSafe', { count: allow.length }) : null,
      deny?.length ? t('project.appliedExposed', { count: deny.length }) : null,
      warn === false ? t('project.appliedNoWarn') : null
    ].filter(Boolean).join(' · ') || null)
    toast(t('toast.profileImported'), 'success')
  }

  // The fixed 480px column left excessive empty
  // gutters on wide displays and cramped-feeling recent-projects rows.
  // Research (JetBrains + Cursor welcome screens, Win32 UX guidance) points
  // at a two-column split above ~800px — brand + new project on the left,
  // recent projects on the right — and a stacked single-column fallback
  // below that so narrow windows behave like the old picker.
  const hasRecent = projects.length > 0
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
      {/* `align-items: center` on a scroll container overflows in BOTH
          directions once the content is taller than the box, and the half
          above the scroll origin cannot be reached — shrink the window and the
          wordmark is cut off with no way to scroll back to it. `safe center`
          centers while it fits and falls back to flex-start when it does not,
          which is the only behaviour that survives a resize. */}
      <div
        className="flex-1 flex justify-center p-6 overflow-y-auto"
        style={{ alignItems: 'safe center' }}
      >
      <div className={`w-full ${hasRecent ? 'max-w-[880px]' : 'max-w-[480px]'} space-y-6`}>
        {/* Header — spans both columns. Centered anchor for identity so the
            wider layout still feels intentional and not empty. */}
        <div className="text-center space-y-2">
          <Wordmark className="text-4xl" />
          <p className="text-redlog-text-faint text-xs font-mono">{t('app.subtitle')}</p>
        </div>

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
          <h2 className="text-redlog-text-dim text-xs font-semibold uppercase tracking-[0.15em] mb-3">{t('project.new')}</h2>
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
          {applied && (
            <p data-testid="profile-applied" className="mt-1 text-xs text-redlog-text-dim font-mono">{applied}</p>
          )}
        </div>

        {/* Recent projects */}
        {projects.length > 0 && (() => {
          const nameCounts = new Map<string, number>()
          for (const p of projects) nameCounts.set(p.name, (nameCounts.get(p.name) ?? 0) + 1)
          return (
          <div className="bg-redlog-surface border border-redlog-border rounded-xl p-5 shadow-card">
            <h2 className="text-redlog-text-dim text-xs font-semibold uppercase tracking-[0.15em] mb-3">{t('project.recent')}</h2>
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

      </div>
      </div>
    </div>
  )
}


