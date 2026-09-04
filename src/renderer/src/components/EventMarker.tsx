import { useState, useEffect, useRef } from 'react'
import { useI18n } from '../i18n'
import { useFocusTrap } from '../lib/useFocusTrap'
import { formatTime } from '../lib/time'
import { Button } from './Button'

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
  const [url, setUrl] = useState('')
  const [severity, setSeverity] = useState<string>('info')
  const [category, setCategory] = useState<string>('custom')
  const [withScreenshot, setWithScreenshot] = useState(true)
  const [saving, setSaving] = useState(false)
  const { t } = useI18n()

  // Prefilled once from the browser connector, then left alone. A poll would
  // fight the operator: they open the dialog BECAUSE of the page they are on,
  // and a later refresh would overwrite what they came to record. Silent on
  // failure — no connector is the normal case.
  useEffect(() => {
    void window.redlog.cdp?.getTab?.()
      .then((tab) => { if (tab?.url) setUrl(tab.url) })
      .catch(() => { /* no browser connected */ })
  }, [])

  // The dialog used to focus itself once and stop there, so Tab walked out
  // into the page behind it (§4). Trap it, and take Escape at the window
  // rather than from a keydown on the backdrop — the backdrop only sees the
  // key if focus happens to be inside it, which is exactly the case that was
  // broken. Backdrop click still covers mouse dismiss.
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const titleRef = useRef<HTMLInputElement | null>(null)
  useFocusTrap(dialogRef, true, titleRef)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleSave = async () => {
    setSaving(true)
    const ts = formatTime(Date.now(), { seconds: true })
    const markerEvent = await window.redlog.marker.create({
      title: title.trim() || t('marker.defaultTitle', { time: ts }),
      notes, severity, category,
      ...(url.trim() ? { url: url.trim() } : {}),
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
        <h3 className="text-sm font-semibold text-redlog-text">
          {t('marker.title')}
          {atTimestamp && (
            <span className="ml-2 text-xs text-amber-400/80 font-mono font-normal">
              {t('marker.atTimestamp', { time: formatTime(atTimestamp, { seconds: true }) })}
            </span>
          )}
        </h3>

        <input
          ref={titleRef}
          type="text"
          placeholder={t('marker.placeholder')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSave()}
          className="w-full bg-redlog-surface border border-redlog-border rounded px-3 py-2 text-sm text-redlog-text placeholder-redlog-text-faint focus:outline-none focus:border-redlog-accent"
        />

        <input
          type="text"
          placeholder={t('marker.fieldUrlPlaceholder')}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-label={t('marker.fieldUrl')}
          className="w-full bg-redlog-surface border border-redlog-border rounded px-3 py-2 text-xs text-redlog-text font-mono placeholder-redlog-text-faint focus:outline-none focus:border-redlog-accent"
        />

        <div className="flex gap-1">
          {SEVERITIES.map((s) => (
            <button
              key={s}
              onClick={() => setSeverity(s)}
              className={`px-3 py-1 text-xs rounded border transition-colors
                ${severity === s ? severityColor[s] : 'border-redlog-border text-redlog-text-dim'}`}
            >
              {t(`marker.severity.${s}`)}
            </button>
          ))}
        </div>

        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="w-full bg-redlog-surface border border-redlog-border rounded px-3 py-1.5 text-xs text-redlog-text focus:outline-none"
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
          className="w-full bg-redlog-surface border border-redlog-border rounded px-3 py-2 text-xs text-redlog-text placeholder-redlog-text-faint focus:outline-none resize-none"
        />

        <label className="flex items-center gap-2 cursor-pointer text-xs text-redlog-text-dim">
          <input
            type="checkbox"
            checked={withScreenshot}
            onChange={(e) => setWithScreenshot(e.target.checked)}
            className="accent-red-600"
          />
          <span>{t('marker.withScreenshot')}</span>
        </label>

        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-3 py-1.5 text-xs text-redlog-text-dim hover:text-redlog-text">
            {t('marker.cancel')}
          </button>
          <Button level="primary" onClick={handleSave} disabled={saving}>
            {saving ? t('marker.saving') : t('marker.submit')}
          </Button>
        </div>
      </div>
    </div>
  )
}
