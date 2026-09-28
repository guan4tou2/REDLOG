import { useState, useEffect, useCallback, useRef } from 'react'
import { Image } from 'lucide-react'
import { EmptyState } from './EmptyState'
import { LoadingSpinner } from './Feedback'
import { confirm as confirmDialog } from './ConfirmDialog'
import { toast } from './Toast'
import { writeClipboard } from '../lib/clipboard'
import { formatTime } from '../lib/time'
import { useI18n } from '../i18n'
import { settingsTarget } from '../lib/navigation'
import { captureScreenshotWithFeedback } from '../lib/captureScreenshot'
import { Modal } from './Modal'

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
  const [loadError, setLoadError] = useState<'first' | 'more' | null>(null)
  const generation = useRef(0)
  const triggerFilterRef = useRef(triggerFilter)
  triggerFilterRef.current = triggerFilter
  const { t } = useI18n()
  // Trigger ids (manual, periodic…) are stored as-is; they are shown in words.
  const triggerLabel = (trigger: string): string => {
    const key = `screenshots.trigger.${trigger}`
    const label = t(key)
    return label === key ? trigger : label
  }

  const loadPage = useCallback(async (trigger: string | null) => {
    const request = ++generation.current
    setLoading(true)
    setLoadingMore(false)
    setLoadError(null)
    try {
      const page = await window.redlog.events.queryScreenshotPage({ limit: PAGE_SIZE, trigger })
      if (request !== generation.current) return
      setScreenshots(page.items)
      setHasMore(page.hasMore)
      setNextCursor(page.nextCursor)
    } catch {
      if (request === generation.current) setLoadError('first')
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadPage(triggerFilter)
    return () => { generation.current++ }
  }, [triggerFilter, loadPage])

  useEffect(() => {
    return window.redlog.events.onNewBatch((events) => {
      for (const event of events) {
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
      }
    })
  }, [])

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    const request = generation.current
    setLoadingMore(true)
    setLoadError(null)
    try {
      const page = await window.redlog.events.queryScreenshotPage({
        limit: PAGE_SIZE, cursor: nextCursor, trigger: triggerFilterRef.current
      })
      if (request !== generation.current) return
      setScreenshots(prev => {
        const ids = new Set(prev.map(event => event.id))
        return [...prev, ...page.items.filter(event => !ids.has(event.id))]
      })
      setHasMore(page.hasMore)
      setNextCursor(page.nextCursor)
    } catch {
      if (request === generation.current) setLoadError('more')
    } finally {
      if (request === generation.current) setLoadingMore(false)
    }
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
      {loadError && (
        <div role="alert" data-testid="screenshots-load-failed" className="text-red-400 text-xs mb-3">
          {t('screenshots.loadFailed')}{' '}
          <button className="underline" onClick={() => void (loadError === 'more' ? loadMore() : loadPage(triggerFilter))}>
            {t('settings.save.retry')}
          </button>
        </div>
      )}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold text-redlog-text-dim uppercase tracking-wider">
          {t('screenshots.title', { count: hasMore ? `${screenshots.length}+` : screenshots.length })}
        </h2>
        <button
          onClick={() => { void captureScreenshotWithFeedback(t) }}
          className="px-2 py-1 text-xs bg-redlog-elevated text-redlog-text rounded hover:bg-redlog-elevated-hover"
        >
          {t('screenshots.captureNow')}
        </button>
      </div>
      {loadError === 'first' ? null : screenshots.length === 0 && !hasMore ? (
        <EmptyState
          icon={Image}
          title={t('screenshots.empty')}
          reason={t('screenshots.emptyReason')}
          action={{
            label: t('screenshots.captureNow'),
            onClick: () => { void captureScreenshotWithFeedback(t) }
          }}
          secondary={{ label: t('screenshots.emptySettings'), onClick: () => onNavigate(settingsTarget('captureControl')) }}
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
              >{triggerLabel(trigger)} <span className="text-redlog-text-faint">&middot;{count}</span></button>
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
              aria-label={t('screenshots.itemLabel', { time: formatTime(s.timestamp, { seconds: true }) })}
              className="group relative rounded border border-redlog-border overflow-hidden bg-redlog-surface cursor-pointer hover:border-redlog-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 transition-colors"
              onClick={() => !deletedIds.has(s.id) && setExpanded(expanded === s.id ? null : s.id)}
              onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !deletedIds.has(s.id)) { e.preventDefault(); setExpanded(expanded === s.id ? null : s.id) } }}
            >
              <div className="aspect-video bg-redlog-surface flex items-center justify-center overflow-hidden">
                {deletedIds.has(s.id) ? (
                  <span className="text-redlog-text-faint text-xs italic">{t('screenshots.deleted')}</span>
                ) : thumbs[s.id] ? (
                  <img
                    src={thumbs[s.id]}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-redlog-text-faint text-xs">{(s.data.filename as string) ?? '...'}</span>
                )}
              </div>
              <div className="px-2 py-1 flex flex-col gap-0.5">
                <div className="flex items-center justify-between gap-1">
                <p title={`${formatTime(s.timestamp, { seconds: true })} — ${triggerLabel(String(s.data.trigger ?? ''))}`} className="text-xs text-redlog-text-dim flex-1 min-w-0 truncate">
                  {formatTime(s.timestamp, { seconds: true })} &mdash; {triggerLabel(String(s.data.trigger ?? ''))}
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
                    onClick={(e) => { e.stopPropagation(); void writeClipboard(s.data.sha256 as string).then((ok) => ok ? toast(t('common.copied'), 'success') : toast(t('common.copyFailed'), 'error')) }}
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
      {(() => {
        // The lightbox (UI/UX audit F20): what the frame is, not just the
        // pixels — when, why it was taken, its hash — and the neighbours
        // without closing it. A shared Modal, so focus stays in it.
        const viewable = screenshots.filter((x) => !deletedIds.has(x.id) && thumbs[x.id])
        const at = expanded ? viewable.findIndex((x) => x.id === expanded) : -1
        const shot = at >= 0 ? viewable[at] : null
        const step = (d: number): void => {
          const next = viewable[at + d]
          if (next) setExpanded(next.id)
        }
        return (
          <Modal
            open={!!shot}
            onClose={() => setExpanded(null)}
            label={t('screenshots.previewLabel')}
            testId="screenshot-lightbox"
            backdropClassName="fixed inset-0 bg-black/80 z-50 flex items-center justify-center"
            panelClassName="flex flex-col items-center gap-2 max-w-[92vw]"
          >
            {shot && (
              <div
                className="flex flex-col items-center gap-2"
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1) }
                  if (e.key === 'ArrowRight') { e.preventDefault(); step(1) }
                }}
              >
                <img src={thumbs[shot.id]} alt="" className="max-w-[90vw] max-h-[78vh] object-contain rounded-lg" />
                <div className="flex items-center gap-3 text-xs text-redlog-text-dim">
                  <button type="button" onClick={() => step(-1)} disabled={at <= 0} aria-label={t('screenshots.prev')} className="px-2 py-1 rounded bg-redlog-elevated hover:bg-redlog-elevated-hover disabled:opacity-40">←</button>
                  <span className="font-mono">{formatTime(shot.timestamp, { seconds: true })}</span>
                  <span>{triggerLabel(String(shot.data.trigger ?? ''))}</span>
                  {typeof shot.data.sha256 === 'string' && (
                    <span className="font-mono text-redlog-text-faint" title={`SHA-256: ${shot.data.sha256 as string}`}>{(shot.data.sha256 as string).slice(0, 12)}</span>
                  )}
                  <span className="text-redlog-text-faint">{at + 1} / {viewable.length}</span>
                  <button type="button" onClick={() => step(1)} disabled={at >= viewable.length - 1} aria-label={t('screenshots.next')} className="px-2 py-1 rounded bg-redlog-elevated hover:bg-redlog-elevated-hover disabled:opacity-40">→</button>
                  <button type="button" onClick={() => setExpanded(null)} aria-label={t('common.close')} className="px-2 py-1 rounded bg-redlog-elevated hover:bg-redlog-elevated-hover">{t('common.close')}</button>
                </div>
              </div>
            )}
          </Modal>
        )
      })()}
    </div>
  )
}
