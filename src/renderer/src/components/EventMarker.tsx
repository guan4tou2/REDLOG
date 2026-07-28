import { useState } from 'react'
import { useI18n } from '../i18n'

const SEVERITIES = ['info', 'important', 'critical'] as const
const CATEGORIES = [
  'initial_access', 'privilege_escalation', 'lateral_movement',
  'exfiltration', 'persistence', 'custom'
] as const

interface EventMarkerProps {
  onClose: () => void
}

export default function EventMarker({ onClose }: EventMarkerProps): JSX.Element {
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [severity, setSeverity] = useState<string>('info')
  const [category, setCategory] = useState<string>('custom')
  const [saving, setSaving] = useState(false)
  const { t } = useI18n()

  const handleSave = async () => {
    setSaving(true)
    const ts = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    await window.redlog.marker.create({ title: title.trim() || t('marker.defaultTitle', { time: ts }), notes, severity, category })
    await window.redlog.screenshot.capture()
    setSaving(false)
    onClose()
  }

  const severityColor = {
    info: 'border-blue-500/50 text-blue-400',
    important: 'border-yellow-500/50 text-yellow-400',
    critical: 'border-red-500/50 text-red-400'
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-redlog-surface border border-redlog-border rounded-lg w-[420px] p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-neutral-300">{t('marker.title')}</h3>

        <input
          autoFocus
          type="text"
          placeholder={t('marker.placeholder')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSave()}
          className="w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-redlog-accent"
        />

        <div className="flex gap-1">
          {SEVERITIES.map((s) => (
            <button
              key={s}
              onClick={() => setSeverity(s)}
              className={`px-3 py-1 text-xs rounded border transition-colors
                ${severity === s ? severityColor[s] : 'border-neutral-700 text-neutral-500'}`}
            >
              {s}
            </button>
          ))}
        </div>

        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-1.5 text-xs text-neutral-300 focus:outline-none"
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>
          ))}
        </select>

        <textarea
          placeholder={t('marker.notes')}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-xs text-neutral-300 placeholder-neutral-600 focus:outline-none resize-none"
        />

        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-3 py-1.5 text-xs text-neutral-500 hover:text-neutral-300">
            {t('marker.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 text-xs bg-redlog-accent text-white rounded hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? t('marker.saving') : t('marker.submit')}
          </button>
        </div>
      </div>
    </div>
  )
}
