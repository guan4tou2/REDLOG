import { useState, useEffect } from 'react'
import { useI18n } from '../i18n'

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
        <div className="text-center">
          <h1 className="text-redlog-accent font-bold text-2xl tracking-wider">{t('app.title')}</h1>
          <p className="text-zinc-500 text-xs mt-1">{t('app.subtitle')}</p>
        </div>

        {/* New project */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <h2 className="text-zinc-400 text-xs font-semibold uppercase tracking-wider mb-3">{t('project.new')}</h2>
          <div className="flex gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              placeholder={t('project.placeholder')}
              autoFocus
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 font-mono focus:outline-none focus:border-red-500 placeholder-zinc-600"
            />
            <button
              onClick={handleCreate}
              disabled={!newName.trim() || creating}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm rounded transition-colors"
            >
              {t('project.create')}
            </button>
          </div>
        </div>

        {/* Recent projects */}
        {projects.length > 0 && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <h2 className="text-zinc-400 text-xs font-semibold uppercase tracking-wider mb-3">{t('project.recent')}</h2>
            <div className="space-y-1">
              {projects.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-zinc-800 cursor-pointer group transition-colors"
                  onClick={() => handleOpen(p.id, p.name)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-zinc-200 text-sm font-medium truncate">{p.name}</div>
                    <div className="text-zinc-600 text-[10px] font-mono">{timeAgo(p.lastOpened)}</div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(p.id) }}
                    className="text-zinc-700 hover:text-red-400 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                    title={t('project.delete')}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <p className="text-zinc-700 text-[10px] text-center">
          {t('project.description')}
        </p>
      </div>
    </div>
  )
}
