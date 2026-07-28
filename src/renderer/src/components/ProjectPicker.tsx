import { useState, useEffect } from 'react'
import { useI18n } from '../i18n'
import { confirm } from './ConfirmDialog'
import { toast } from './Toast'

interface ProjectPickerProps {
  onProjectOpen: (project: { id: string; name: string }) => void
}

export default function ProjectPicker({ onProjectOpen }: ProjectPickerProps): JSX.Element {
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [scopeTargets, setScopeTargets] = useState<string[]>([])
  const [safeIPs, setSafeIPs] = useState<string[]>([])
  const [exposedIPs, setExposedIPs] = useState<string[]>([])
  const [enforcement, setEnforcement] = useState('warn')
  const { t } = useI18n()

  useEffect(() => {
    window.redlog.project.list().then(setProjects)
  }, [])

  async function handleCreate(): Promise<void> {
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    const initialConfig = (showAdvanced && (scopeTargets.length > 0 || safeIPs.length > 0 || exposedIPs.length > 0))
      ? {
        scope: { targets: scopeTargets, excludeTargets: [], enforcement, scopeFile: null },
        network: { safeIPs, exposedIPs, checkInterval: 10 }
      }
      : undefined
    const project = await window.redlog.project.create(name, initialConfig)
    onProjectOpen({ id: project.id, name: project.name })
  }

  async function handleOpen(id: string, name: string): Promise<void> {
    const project = await window.redlog.project.open(id)
    if (project) onProjectOpen({ id: project.id, name: project.name })
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
    if (profile.network?.safeIPs) setSafeIPs(profile.network.safeIPs)
    if (profile.network?.exposedIPs) setExposedIPs(profile.network.exposedIPs)
    if (profile.scope?.enforcement) setEnforcement(profile.scope.enforcement)
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
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-red-500/10 border border-red-500/20 mb-2">
            <span className="text-red-500 text-xl font-bold">R</span>
          </div>
          <h1 className="text-zinc-100 font-bold text-xl tracking-[0.15em]">{t('app.title')}</h1>
          <p className="text-zinc-600 text-[11px] font-mono">{t('app.subtitle')}</p>
        </div>

        {/* New project */}
        <div className="bg-redlog-surface border border-redlog-border rounded-xl p-5 shadow-card">
          <h2 className="text-zinc-500 text-[10px] font-semibold uppercase tracking-[0.15em] mb-3">{t('project.new')}</h2>
          <div className="flex gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !showAdvanced && handleCreate()}
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

          {/* Advanced toggle */}
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="mt-3 text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors flex items-center gap-1"
          >
            <span className="text-zinc-700">{showAdvanced ? '▾' : '▸'}</span>
            {t('project.advancedSetup')}
          </button>

          {/* Advanced setup */}
          {showAdvanced && (
            <div className="mt-3 space-y-3 border-t border-redlog-border pt-3">
              {/* Scope targets */}
              <MiniListField
                label={t('project.scopeTargets')}
                items={scopeTargets}
                onChange={setScopeTargets}
                placeholder={t('project.scopePlaceholder')}
              />

              {/* Safe IPs */}
              <MiniListField
                label={t('project.safeIps')}
                items={safeIPs}
                onChange={setSafeIPs}
                placeholder={t('settings.safeIpPlaceholder')}
              />

              {/* Exposed IPs */}
              <MiniListField
                label={t('project.exposedIps')}
                items={exposedIPs}
                onChange={setExposedIPs}
                placeholder={t('settings.exposedIpPlaceholder')}
              />

              {/* Enforcement mode */}
              <div>
                <label className="text-[10px] text-zinc-500 block mb-1">{t('project.enforcement')}</label>
                <div className="flex gap-1.5">
                  {['warn', 'log'].map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setEnforcement(mode)}
                      className={`px-3 py-1 text-[10px] rounded ${
                        enforcement === mode
                          ? 'bg-red-600 text-white'
                          : 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700'
                      }`}
                    >
                      {mode.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              {/* Import profile divider */}
              <div className="flex items-center gap-3 pt-1">
                <div className="flex-1 border-t border-zinc-800" />
                <span className="text-[10px] text-zinc-700">{t('project.or')}</span>
                <div className="flex-1 border-t border-zinc-800" />
              </div>

              <button
                onClick={handleImportProfile}
                className="w-full py-2 bg-zinc-800/50 border border-dashed border-zinc-700 rounded-lg text-xs text-zinc-500 hover:text-zinc-300 hover:border-zinc-500 transition-colors"
              >
                {t('project.importProfile')}
              </button>
            </div>
          )}
        </div>

        {/* Recent projects */}
        {projects.length > 0 && (
          <div className="bg-redlog-surface border border-redlog-border rounded-xl p-5 shadow-card">
            <h2 className="text-zinc-500 text-[10px] font-semibold uppercase tracking-[0.15em] mb-3">{t('project.recent')}</h2>
            <div className="space-y-0.5">
              {projects.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/[0.03] cursor-pointer group transition-colors"
                  onClick={() => handleOpen(p.id, p.name)}
                >
                  <div className="w-1.5 h-1.5 rounded-full bg-red-500/40 group-hover:bg-red-500/80 transition-colors shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-zinc-200 text-[13px] font-medium truncate">{p.name}</div>
                    <div className="text-zinc-600 text-[10px] font-mono">{timeAgo(p.lastOpened)}</div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(p.id) }}
                    className="text-zinc-700 hover:text-red-400 text-xs opacity-0 group-hover:opacity-100 transition-all"
                    title={t('project.delete')}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <p className="text-zinc-700 text-[10px] text-center font-mono">
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
      <label className="text-[10px] text-zinc-500 block mb-1">{label}</label>
      <div className="flex gap-1">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); addItem() } }}
          placeholder={placeholder}
          className="flex-1 bg-redlog-bg border border-zinc-800 rounded px-2 py-1 text-[11px] text-zinc-200 font-mono focus:outline-none focus:border-red-500/50"
        />
        <button onClick={addItem} className="px-2 py-1 bg-zinc-800 text-zinc-500 text-[10px] rounded hover:bg-zinc-700">+</button>
      </div>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {items.map((item, i) => (
            <span key={i} className="inline-flex items-center gap-1 bg-zinc-800 text-zinc-400 text-[10px] font-mono px-1.5 py-0.5 rounded">
              {item}
              <button onClick={() => onChange(items.filter((_, j) => j !== i))} className="text-zinc-600 hover:text-red-400">×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
