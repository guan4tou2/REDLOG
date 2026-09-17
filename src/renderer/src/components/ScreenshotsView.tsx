import { useState, useEffect } from 'react'
import { Image } from 'lucide-react'
import { EmptyState } from './EmptyState'
import { LoadingSpinner } from './Feedback'
import { confirm as confirmDialog } from './ConfirmDialog'
import { toast } from './Toast'
import { formatTime } from '../lib/time'
import { useI18n } from '../i18n'

export function ScreenshotsView({ onNavigate }: { onNavigate: (v: string) => void }): JSX.Element {
  const [screenshots, setScreenshots] = useState<RedLogEvent[]>([])
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Track which screenshots have had their file purged in this session so the
  // grid shows a placeholder + a "(deleted)" hint even before the next reload.
  // The event STAYS in the DB — we only unlink the JPEG, and a system.
  // screenshot_deleted audit event is appended (see main:screenshot:deleteFile).
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set())
  const [triggerFilter, setTriggerFilter] = useState<string | null>(null)
  const { t } = useI18n()

  useEffect(() => {
    // Cap of 50 was hardcoded (audit finding #30). Bumped to 500 — matches the
    // default limit used elsewhere in the app; for engagements with thousands
    // of shots we'd want pagination but 500 covers the common case cleanly.
    window.redlog.events.query({ agentType: 'screenshot', limit: 500 }).then((s) => {
      setScreenshots(s)
      setLoading(false)
    })
    return window.redlog.events.onNew((event) => {
      if (event.agentType === 'screenshot') {
        setScreenshots((prev) => [event, ...prev].slice(0, 500))
      }
      // Someone else (e.g. the CLI) deleted a shot's file -> mark it locally too.
      if (event.agentType === 'system' && event.data?.subtype === 'screenshot_deleted') {
        // v0.6.96 Clean-4: read _causes[0] instead of legacy source_event.
        // Both are still written today but this is the last renderer read of
        // source_event — after v0.7.x we can drop the dual-write in main.
        const causes = event.data?._causes as string[] | undefined
        const src = causes?.[0] || (event.data?.source_event as string | undefined)
        if (src) setDeletedIds((prev) => { const n = new Set(prev); n.add(src); return n })
      }
    })
  }, [])

  useEffect(() => {
    // v0.6.97 B: pull thumbs directly via `redlog-screenshot://` scheme
    // (main-process protocol.handle registered at whenReady). No IPC round-
    // trip and no 33% base64 inflation — Chromium streams the JPEG from disk.
    // The filename basename is all we send; the main handler resolves it
    // against the project's screenshots dir with an isInsideDir guard.
    screenshots.forEach((s) => {
      if (thumbs[s.id]) return
      const filePath = s.data.filePath as string | undefined
      if (!filePath) return
      const basename = filePath.split(/[\\/]/).pop() || ''
      if (!basename) return
      setThumbs((prev) => ({ ...prev, [s.id]: `redlog-screenshot://local/${encodeURIComponent(basename)}` }))
    })
  }, [screenshots, thumbs])

  if (loading) {
    return (
      <LoadingSpinner />
    )
  }

  return (
    <div className="p-4 overflow-auto h-full">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold text-redlog-text-dim uppercase tracking-wider">
          {t('screenshots.title', { count: screenshots.length })}
        </h2>
        <button
          onClick={() => window.redlog.screenshot.capture()}
          className="px-2 py-1 text-xs bg-redlog-elevated text-redlog-text rounded hover:bg-redlog-elevated-hover"
        >
          {t('screenshots.captureNow')}
        </button>
      </div>
      {screenshots.length === 0 ? (
        <EmptyState
          icon={Image}
          title={t('screenshots.empty')}
          reason={t('screenshots.emptyReason')}
          action={{
            label: t('screenshots.captureNow'),
            onClick: () => { void window.redlog.screenshot.capture() }
          }}
          secondary={{ label: t('screenshots.emptyEnable'), onClick: () => onNavigate('settings') }}
        />
      ) : (() => {
        // Trigger filter (audit #32) — all captures land in one grid mixing
        // periodic / manual / mark-triggered. Chip toggles narrow the view.
        const triggerCounts = new Map<string, number>()
        for (const s of screenshots) triggerCounts.set(s.data.trigger as string, (triggerCounts.get(s.data.trigger as string) ?? 0) + 1)
        const triggers = [...triggerCounts.entries()].sort((a, b) => b[1] - a[1])
        const visibleShots = triggerFilter ? screenshots.filter((s) => s.data.trigger === triggerFilter) : screenshots
        return (
        <>
        {triggers.length > 1 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {triggers.map(([trigger, count]) => (
              <button
                key={trigger}
                onClick={() => setTriggerFilter(triggerFilter === trigger ? null : trigger)}
                className={`px-2 py-0.5 text-xs font-mono rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 ${
                  triggerFilter === trigger ? 'bg-red-500/20 text-red-300' : 'bg-redlog-elevated text-redlog-text-dim hover:text-redlog-text hover:bg-redlog-elevated-hover'
                }`}
              >{trigger} <span className="text-redlog-text-faint">&middot;{count}</span></button>
            ))}
          </div>
        )}
        <div className="grid grid-cols-3 gap-2">
          {visibleShots.map((s) => (
            <div
              key={s.id}
              role="button"
              tabIndex={0}
              aria-label={`Screenshot at ${formatTime(s.timestamp, { seconds: true })}`}
              className="group relative rounded border border-redlog-border overflow-hidden bg-redlog-surface cursor-pointer hover:border-redlog-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 transition-colors"
              onClick={() => !deletedIds.has(s.id) && setExpanded(expanded === s.id ? null : s.id)}
              onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !deletedIds.has(s.id)) { e.preventDefault(); setExpanded(expanded === s.id ? null : s.id) } }}
            >
              <div className="aspect-video bg-redlog-surface flex items-center justify-center overflow-hidden">
                {deletedIds.has(s.id) ? (
                  <span className="text-redlog-muted text-xs italic">{t('screenshots.deleted')}</span>
                ) : thumbs[s.id] ? (
                  // v0.6.98 A: `loading="lazy"` defers the JPEG fetch/decode
                  // until the tile nears the viewport (Chromium native, works
                  // on the `redlog-screenshot://` scheme). `decoding="async"`
                  // keeps decode off the main thread. With 500 shots in the
                  // grid this drops steady-state RAM by ~150MB and gets rid
                  // of the paint stall when opening the panel cold.
                  <img
                    src={thumbs[s.id]}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-redlog-muted text-xs">{(s.data.filename as string) ?? '...'}</span>
                )}
              </div>
              <div className="px-2 py-1 flex items-center justify-between gap-1">
                <p title={`${formatTime(s.timestamp, { seconds: true })} — ${String(s.data.trigger ?? '')}`} className="text-xs text-redlog-text-dim flex-1 min-w-0 truncate">
                  {formatTime(s.timestamp, { seconds: true })} &mdash; {s.data.trigger as string}
                  {s.data.diffPercent !== undefined && (
                    <span className="ml-1 text-redlog-text-faint">({t('screenshots.diff', { pct: (s.data.diffPercent as number).toFixed(1) })})</span>
                  )}
                </p>
                {!deletedIds.has(s.id) && (
                  <button
                    onClick={async (e) => {
                      e.stopPropagation()
                      const ok = await confirmDialog(t('screenshots.deleteTitle'), t('screenshots.deleteConfirm'), true)
                      if (!ok) return
                      const fp = s.data.filePath as string | undefined
                      if (!fp) return
                      const res = await window.redlog.screenshot.deleteFile(s.id, fp)
                      if (res.ok) {
                        setDeletedIds((prev) => { const n = new Set(prev); n.add(s.id); return n })
                        toast(t('screenshots.deletedToast'), 'success')
                      } else {
                        toast(t('screenshots.deleteFailed'), {
                          type: 'error',
                          why: t('screenshots.deleteFailedWhy'),
                          detail: res.error
                        })
                      }
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                    className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 text-xs text-redlog-text-faint hover:text-red-400 focus-visible:text-red-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 rounded transition-opacity"
                    title={t('screenshots.deleteTitle')}
                    aria-label={t('screenshots.deleteTitle')}
                  >&times;</button>
                )}
              </div>
            </div>
          ))}
        </div>
        </>
        )
      })()}
      {expanded && thumbs[expanded] && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Screenshot preview"
          tabIndex={-1}
          ref={(el) => el?.focus()}
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center cursor-pointer outline-none"
          onClick={() => setExpanded(null)}
          onKeyDown={(e) => { if (e.key === 'Escape') setExpanded(null) }}
        >
          <img src={thumbs[expanded]} alt="" className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg" />
        </div>
      )}
    </div>
  )
}
