import { useState } from 'react'
import { useI18n } from '../i18n'

const SEVERITIES = ['info', 'important', 'critical'] as const
const CATEGORIES = [
  'initial_access', 'privilege_escalation', 'lateral_movement',
  'exfiltration', 'persistence', 'custom'
] as const

interface EventMarkerProps {
  onClose: () => void
  // v0.6.87 C1: when set, marker is stamped "for" this wall-clock timestamp
  // (usually from a right-click on Timeline at a specific position). The
  // chain event is still created at Date.now() — timestamp forging would
  // break the audit chain — but data.atTimestamp preserves the intended
  // moment for Timeline rendering.
  atTimestamp?: number
}

export default function EventMarker({ onClose, atTimestamp }: EventMarkerProps): JSX.Element {
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [severity, setSeverity] = useState<string>('info')
  const [category, setCategory] = useState<string>('custom')
  const [withScreenshot, setWithScreenshot] = useState(true)
  const [saving, setSaving] = useState(false)
  const { t } = useI18n()

  // Close on Escape — audit finding P1 #30 (modals need proper keyboard).
  // Backdrop click handler on the outer div covers mouse dismiss.
  const dialogRef = ((): ((el: HTMLDivElement | null) => void) => {
    return (el) => { el?.focus() }
  })()

  const handleSave = async () => {
    setSaving(true)
    const ts = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const markerEvent = await window.redlog.marker.create({
      title: title.trim() || t('marker.defaultTitle', { time: ts }),
      notes, severity, category,
      ...(atTimestamp ? { atTimestamp } : {})
    })
    // Screenshot is opt-out — if the operator is looking at sensitive UI they
    // shouldn't capture, they can uncheck. Default stays on (matches prior
    // behaviour + is the safer default for evidence). Audit P1 #29.
    // v0.6.89 `_causes`: pass the marker event id so focus chain links
    // marker → screenshot → (later screenshot_deleted).
    if (withScreenshot) await window.redlog.screenshot.capture(markerEvent?.id)
    setSaving(false)
    onClose()
  }

  const severityColor = {
    info: 'border-blue-500/50 text-blue-400',
    important: 'border-yellow-500/50 text-yellow-400',
    critical: 'border-red-500/50 text-red-400'
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 select-text"
      onClick={onClose}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('marker.title')}
        tabIndex={-1}
        className="bg-redlog-surface border border-redlog-border rounded-lg w-[420px] p-4 space-y-3 outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-neutral-300">
          {t('marker.title')}
          {atTimestamp && (
            <span className="ml-2 text-[11px] text-amber-400/80 font-mono font-normal">
              {t('marker.atTimestamp', { time: new Date(atTimestamp).toLocaleTimeString() })}
            </span>
          )}
        </h3>

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
              {t(`marker.severity.${s}`)}
            </button>
          ))}
        </div>

        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-1.5 text-xs text-neutral-300 focus:outline-none"
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{t(`marker.category.${c}`)}</option>
          ))}
        </select>

        <textarea
          placeholder={t('marker.notes')}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="w-full bg-neutral-900 border border-neutral-700 rounded px-3 py-2 text-xs text-neutral-300 placeholder-neutral-600 focus:outline-none resize-none"
        />

        <label className="flex items-center gap-2 cursor-pointer text-xs text-neutral-400">
          <input
            type="checkbox"
            checked={withScreenshot}
            onChange={(e) => setWithScreenshot(e.target.checked)}
            className="accent-red-600"
          />
          <span>{t('marker.withScreenshot')}</span>
        </label>

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
