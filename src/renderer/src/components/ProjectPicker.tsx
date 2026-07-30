import { useState, useEffect } from 'react'
import { useI18n } from '../i18n'
import { confirm } from './ConfirmDialog'
import { toast } from './Toast'
import logoUrl from '../assets/logo.svg'

interface ProjectPickerProps {
  onProjectOpen: (project: { id: string; name: string }) => void
}

export default function ProjectPicker({ onProjectOpen }: ProjectPickerProps): JSX.Element {
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [scopeTargets, setScopeTargets] = useState<string[]>([])
  const [whitelist, setWhitelist] = useState<string[]>([])
  const [blacklist, setBlacklist] = useState<string[]>([])
  const [warnOnViolation, setWarnOnViolation] = useState(true)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const { t } = useI18n()

  async function handleRenameCommit(id: string): Promise<void> {
    const name = renameValue.trim()
    setRenamingId(null)
    if (!name) return
    const orig = projects.find((p) => p.id === id)?.name
    if (name === orig) return
    const updated = await (window.redlog.project as { rename?: (id: string, n: string) => Promise<ProjectMeta | null> }).rename?.(id, name)
    if (updated) setProjects((prev) => prev.map((p) => p.id === id ? updated : p))
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
      const initialConfig = (showAdvanced && (scopeTargets.length > 0 || whitelist.length > 0 || blacklist.length > 0))
        ? {
          scope: { targets: scopeTargets, excludeTargets: [], warnOnViolation, scopeFile: null },
          network: { whitelist, blacklist, checkInterval: 60 }
        }
        : undefined
      const project = await window.redlog.project.create(name, initialConfig)
      onProjectOpen({ id: project.id, name: project.name })
    } catch (e) {
      setCreating(false)
      toast(t('project.openFailed', { error: (e as Error).message }), 'error')
    }
  }

  async function handleOpen(id: string): Promise<void> {
    try {
      const project = await window.redlog.project.open(id)
      if (project) onProjectOpen({ id: project.id, name: project.name })
      else toast(t('project.openMissing'), 'error')
    } catch (e) {
      toast(t('project.openFailed', { error: (e as Error).message }), 'error')
    }
  }

  async function handleDelete(id: string): Promise<void> {
    const ok = await confirm(t('confirm.deleteProject'), t('confirm.deleteProjectDesc'), true)
    if (!ok) return
    await window.redlog.project.delete(id)
    setProjects((prev) => prev.filter((p) => p.id !== id))
  }

  async function handleImportProfile(): Promise<void> {
    const profile = await window.redlog.config.importProfile() as RedLogConfigPartial | null
    if (!profile) return
    if (profile.scope?.targets) setScopeTargets(profile.scope.targets)
    if (profile.network?.whitelist ?? profile.network?.safeIPs) setWhitelist(profile.network.whitelist ?? profile.network.safeIPs)
    if (profile.network?.blacklist ?? profile.network?.exposedIPs) setBlacklist(profile.network.blacklist ?? profile.network.exposedIPs)
    // Migrate legacy 'log' → warnings off; 'warn' or unset → on. Direct boolean wins.
    if (profile.scope?.warnOnViolation !== undefined) setWarnOnViolation(profile.scope.warnOnViolation)
    else if (profile.scope?.enforcement) setWarnOnViolation(profile.scope.enforcement !== 'log')
    setShowAdvanced(true)
    toast(t('toast.profileImported'), 'success')
  }

  function timeAgo(ts: number): string {
    const diff = Date.now() - ts
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return t('time.justNow')
    if (mins < 60) return t('time.mAgo', { m: mins })
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return t('time.hAgo', { h: hrs })
    const days = Math.floor(hrs / 24)
    return t('time.dAgo', { d: days })
  }

  return (
    <div className="h-screen flex items-center justify-center bg-[#0a0a0a]">
      <div className="w-[480px] space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <img src={logoUrl} alt="RedLog" className="w-14 h-14 mx-auto mb-2 rounded-xl" />

          <h1 className="text-zinc-100 font-bold text-xl tracking-[0.15em]">{t('app.title')}</h1>
          <p className="text-zinc-600 text-[11px] font-mono">{t('app.subtitle')}</p>
        </div>

        {bridgeMissing && (
          <div className="bg-red-950/40 border border-red-900/50 rounded-xl p-4 text-center">
            <p className="text-red-300 text-xs">{t('project.bridgeMissing')}</p>
          </div>
        )}

        {/* New project */}
        <div className="bg-redlog-surface border border-redlog-border rounded-xl p-5 shadow-card">
          <h2 className="text-zinc-500 text-xs font-semibold uppercase tracking-[0.15em] mb-3">{t('project.new')}</h2>
          <div className="flex gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              placeholder={t('project.placeholder')}
              autoFocus
              className="flex-1 bg-redlog-bg border border-redlog-border rounded-lg px-3 py-2 text-sm text-zinc-200 font-mono focus:outline-none focus:border-red-500/50 focus:ring-1 focus:ring-red-500/20 placeholder-zinc-700 transition-all"
            />
            <button
              onClick={handleCreate}
              disabled={!newName.trim() || creating}
              className="px-4 py-2 bg-red-600 hover:bg-red-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {t('project.create')}
            </button>
          </div>

          {/* Advanced toggle — opens a modal instead of expanding inline. The
              inline version pushed the recent-projects list off the viewport
              on smaller windows; the modal keeps the picker at a fixed size. */}
          <button
            onClick={() => setShowAdvanced(true)}
            className="mt-3 text-xs text-zinc-600 hover:text-zinc-400 transition-colors flex items-center gap-1"
          >
            <span className="text-zinc-700">▸</span>
            {t('project.advancedSetup')}
            {(scopeTargets.length + whitelist.length + blacklist.length > 0) && (
              <span className="ml-1 text-zinc-500">
                ({t('project.advancedSummary', {
                  scope: scopeTargets.length,
                  safe: whitelist.length,
                  exposed: blacklist.length
                })})
              </span>
            )}
          </button>
        </div>

        {/* Advanced setup modal */}
        {showAdvanced && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={() => setShowAdvanced(false)}
            onKeyDown={(e) => { if (e.key === 'Escape') setShowAdvanced(false) }}
            role="presentation"
          >
            <div
              ref={(el) => el?.focus()}
              role="dialog"
              aria-modal="true"
              aria-label={t('project.advancedSetup')}
              tabIndex={-1}
              className="bg-redlog-surface border border-redlog-border rounded-xl p-5 shadow-card w-full max-w-md max-h-[90vh] overflow-y-auto outline-none"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-zinc-300 text-[11px] font-semibold uppercase tracking-[0.15em]">
                  {t('project.advancedSetup')}
                </h2>
                <button
                  onClick={() => setShowAdvanced(false)}
                  className="text-zinc-600 hover:text-zinc-300 text-lg leading-none"
                  aria-label={t('project.close')}
                >
                  ×
                </button>
              </div>

              <div className="space-y-3">
                <MiniListField
                  label={t('project.scopeTargets')}
                  items={scopeTargets}
                  onChange={setScopeTargets}
                  placeholder={t('project.scopePlaceholder')}
                />
                <MiniListField
                  label={t('project.whitelist')}
                  items={whitelist}
                  onChange={setWhitelist}
                  placeholder={t('settings.safeIpPlaceholder')}
                />
                <MiniListField
                  label={t('project.blacklist')}
                  items={blacklist}
                  onChange={setBlacklist}
                  placeholder={t('settings.exposedIpPlaceholder')}
                />

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={warnOnViolation}
                    onChange={(e) => setWarnOnViolation(e.target.checked)}
                    className="accent-red-600"
                  />
                  <span className="text-xs text-zinc-300">{t('project.warnOnViolation')}</span>
                </label>
                <p className="text-xs text-zinc-600 -mt-1">{t('project.warnOnViolationHint')}</p>

                <div className="flex items-center gap-3 pt-1">
                  <div className="flex-1 border-t border-zinc-800" />
                  <span className="text-xs text-zinc-700">{t('project.or')}</span>
                  <div className="flex-1 border-t border-zinc-800" />
                </div>

                <button
                  onClick={handleImportProfile}
                  className="w-full py-2 bg-zinc-800/50 border border-dashed border-zinc-700 rounded-lg text-xs text-zinc-500 hover:text-zinc-300 hover:border-zinc-500 transition-colors"
                >
                  {t('project.importProfile')}
                </button>
              </div>

              <div className="flex justify-end mt-5 pt-3 border-t border-redlog-border">
                <button
                  onClick={() => setShowAdvanced(false)}
                  className="px-4 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg transition-colors"
                >
                  {t('project.done')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Recent projects */}
        {projects.length > 0 && (
          <div className="bg-redlog-surface border border-redlog-border rounded-xl p-5 shadow-card">
            <h2 className="text-zinc-500 text-xs font-semibold uppercase tracking-[0.15em] mb-3">{t('project.recent')}</h2>
            <div className="space-y-0.5">
              {projects.map((p) => (
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
                        className="w-full bg-redlog-bg border border-redlog-border rounded px-2 py-0.5 text-zinc-200 text-[13px] font-medium font-mono focus:outline-none focus:border-red-500/50"
                      />
                    ) : (
                      <div className="text-zinc-200 text-[13px] font-medium truncate">{p.name}</div>
                    )}
                    <div className="text-zinc-600 text-xs font-mono">{timeAgo(p.lastOpened)}</div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); setRenamingId(p.id); setRenameValue(p.name) }}
                    className="text-zinc-700 hover:text-zinc-300 focus:text-zinc-300 text-xs opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 transition-all px-1"
                    title={t('project.rename')}
                    aria-label={t('project.rename')}
                  >
                    ✎
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(p.id) }}
                    className="text-zinc-700 hover:text-red-400 focus:text-red-400 text-xs opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 transition-all"
                    title={t('project.delete')}
                    aria-label={t('project.delete')}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <p className="text-zinc-700 text-xs text-center font-mono">
          {t('project.description')}
        </p>
      </div>
    </div>
  )
}

function MiniListField({ label, items, onChange, placeholder }: {
  label: string; items: string[]; onChange: (items: string[]) => void; placeholder: string
}): JSX.Element {
  const [input, setInput] = useState('')

  const addItem = (): void => {
    const trimmed = input.trim()
    if (trimmed && !items.includes(trimmed)) {
      onChange([...items, trimmed])
      setInput('')
    }
  }

  return (
    <div>
      <label className="text-xs text-zinc-500 block mb-1">{label}</label>
      <div className="flex gap-1">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); addItem() } }}
          placeholder={placeholder}
          className="flex-1 bg-redlog-bg border border-zinc-800 rounded px-2 py-1 text-[11px] text-zinc-200 font-mono focus:outline-none focus:border-red-500/50"
        />
        <button onClick={addItem} className="px-2 py-1 bg-zinc-800 text-zinc-500 text-xs rounded hover:bg-zinc-700">+</button>
      </div>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {items.map((item, i) => (
            <span key={i} className="inline-flex items-center gap-1 bg-zinc-800 text-zinc-400 text-xs font-mono px-1.5 py-0.5 rounded">
              {item}
              <button onClick={() => onChange(items.filter((_, j) => j !== i))} className="text-zinc-600 hover:text-red-400">×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
