import { useState, useEffect } from 'react'
import { useI18n } from '../i18n'
import { confirm } from './ConfirmDialog'

interface ProjectPickerProps {
  onProjectOpen: (project: { id: string; name: string }) => void
}

export default function ProjectPicker({ onProjectOpen }: ProjectPickerProps): JSX.Element {
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const { t } = useI18n()

  useEffect(() => {
    window.redlog.project.list().then(setProjects)
  }, [])

  async function handleCreate(): Promise<void> {
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    const project = await window.redlog.project.create(name)
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
      <div className="w-[420px] space-y-6">
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
