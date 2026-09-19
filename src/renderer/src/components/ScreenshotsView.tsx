import { useState, useEffect, useCallback, useRef } from 'react'
import { Image } from 'lucide-react'
import { EmptyState } from './EmptyState'
import { LoadingSpinner } from './Feedback'
import { confirm as confirmDialog } from './ConfirmDialog'
import { toast } from './Toast'
import { formatTime } from '../lib/time'
import { useI18n } from '../i18n'

const PAGE_SIZE = 100

export function ScreenshotsView({ onNavigate }: { onNavigate: (v: string) => void }): JSX.Element {
  const [screenshots, setScreenshots] = useState<RedLogEvent[]>([])
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set())
  const [triggerFilter, setTriggerFilter] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const triggerFilterRef = useRef(triggerFilter)
  triggerFilterRef.current = triggerFilter
  const { t } = useI18n()

  const loadPage = useCallback(async (trigger: string | null) => {
    setLoading(true)
    const page = await window.redlog.events.queryScreenshotPage({
      limit: PAGE_SIZE,
      trigger
    })
    setScreenshots(page.items)
    setHasMore(page.hasMore)
    setNextCursor(page.nextCursor)
    setLoading(false)
  }, [])

  useEffect(() => {
    void loadPage(triggerFilter)
  }, [triggerFilter, loadPage])

  useEffect(() => {
    return window.redlog.events.onNew((event) => {
      if (event.agentType === 'screenshot') {
        const tf = triggerFilterRef.current
        if (!tf || event.data?.trigger === tf) {
          setScreenshots((prev) => {
            if (prev.some((e) => e.id === event.id)) return prev
            return [event, ...prev]
          })
        }
      }
      if (event.agentType === 'system' && event.data?.subtype === 'screenshot_deleted') {
        const causes = event.data?._causes as string[] | undefined
        const src = causes?.[0] || (event.data?.source_event as string | undefined)
        if (src) setDeletedIds((prev) => { const n = new Set(prev); n.add(src); return n })
      }
    })
  }, [])

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    const page = await window.redlog.events.queryScreenshotPage({
      limit: PAGE_SIZE,
      cursor: nextCursor,
      trigger: triggerFilterRef.current
    })
    setScreenshots((prev) => [...prev, ...page.items])
    setHasMore(page.hasMore)
    setNextCursor(page.nextCursor)
    setLoadingMore(false)
  }, [nextCursor, loadingMore])

  useEffect(() => {
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
      {screenshots.length === 0 && !hasMore ? (
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
        const triggerCounts = new Map<string, number>()
        for (const s of screenshots) triggerCounts.set(s.data.trigger as string, (triggerCounts.get(s.data.trigger as string) ?? 0) + 1)
        const triggers = [...triggerCounts.entries()].sort((a, b) => b[1] - a[1])
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
        <p className="text-redlog-text-dim text-xs mb-2">
          {t('screenshots.loaded', { count: screenshots.length })}
        </p>
        <div className="grid grid-cols-3 gap-2">
          {screenshots.map((s) => (
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
              <div className="px-2 py-1 flex flex-col gap-0.5">
                <div className="flex items-center justify-between gap-1">
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
                {typeof s.data.sha256 === 'string' && (
                  <button
                    onClick={(e) => { e.stopPropagation(); void navigator.clipboard.writeText(s.data.sha256 as string) }}
                    className="text-xs font-mono text-redlog-text-faint hover:text-redlog-text truncate text-left transition-colors"
                    title={`SHA-256: ${s.data.sha256 as string}`}
                  >
                    {(s.data.sha256 as string).slice(0, 12)}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        {hasMore && (
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="mt-3 w-full text-xs text-blue-400 hover:text-blue-300 disabled:text-redlog-text-faint py-2"
          >
            {loadingMore ? t('screenshots.loading') : t('screenshots.loadMore')}
          </button>
        )}
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
