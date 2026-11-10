import { useEffect, useRef } from 'react'
import { useI18n } from '../i18n'
import { useReadState } from '../lib/readState'

export type EvidencePage = 'screenshots' | 'loot' | 'bookmarks'
const PAGES: EvidencePage[] = ['screenshots', 'loot', 'bookmarks']
const TAB_LABEL: Record<EvidencePage, string> = { screenshots: 'sidebar.screens', loot: 'sidebar.loot', bookmarks: 'sidebar.bookmarks' }

/** Bookmarks change inside their own page; the header hears about it here
 *  instead of reading the list on a timer. */
export const BOOKMARKS_CHANGED = 'redlog:bookmarks-changed'

/** Heading and the three evidence pages as tabs. A tab shows a count only when
 *  it is a total: screenshots and bookmarks are counted over the whole project.
 *  Loot has none here, because its page counts matches inside events and a
 *  second number for the same thing would disagree with it. */
export function EvidenceHeader({ page, onNavigate }: {
  page: EvidencePage
  onNavigate: (page: EvidencePage) => void
}): JSX.Element {
  const { t } = useI18n()
  const shots = useReadState(() => window.redlog.events.count({ filter: { agentType: 'screenshot' } }))
  const marks = useReadState(async () => (await window.redlog.bookmarks.list()).length)
  const { retry: retryShots } = shots
  const { retry: retryMarks } = marks
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const onMarks = (): void => retryMarks()
    window.addEventListener(BOOKMARKS_CHANGED, onMarks)
    // One read per burst of new events, not one per batch.
    const unsub = window.redlog.events.onNewBatch((events) => {
      if (!events.some((e) => e.agentType === 'screenshot')) return
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(retryShots, 1000)
    })
    return () => { window.removeEventListener(BOOKMARKS_CHANGED, onMarks); unsub(); if (timer.current) clearTimeout(timer.current) }
  }, [retryShots, retryMarks])

  const counts: Record<EvidencePage, number | null> = {
    screenshots: shots.state.value,
    loot: null,
    bookmarks: marks.state.value
  }

  return <div data-testid="evidence-header" className="shrink-0 space-y-2 px-4 pt-3">
    <div className="min-w-0">
      <h1 className="text-lg font-semibold text-redlog-text">{t('sidebar.evidence')}</h1>
      {/* The one-line hint gives way when the window is short (a small window at
          high zoom): the tabs must not push the page's own content out of reach. */}
      <p className="mt-1 hidden text-xs text-redlog-text-dim [@media(min-height:640px)]:block">{t('evidence.hint')}</p>
    </div>
    <div role="tablist" aria-label={t('sidebar.evidence')} className="flex gap-4 border-b border-redlog-border">
      {PAGES.map((id, index) => {
        const count = counts[id]
        const selected = page === id
        return <button key={id} type="button" role="tab" data-view-btn={id} aria-selected={selected} tabIndex={selected ? 0 : -1}
          onClick={() => onNavigate(id)}
          onKeyDown={(e) => {
            const next = e.key === 'ArrowRight' ? PAGES[(index + 1) % PAGES.length] : e.key === 'ArrowLeft' ? PAGES[(index + PAGES.length - 1) % PAGES.length] : undefined
            if (next) { e.preventDefault(); onNavigate(next); document.querySelector<HTMLButtonElement>(`button[role="tab"][data-view-btn="${next}"]`)?.focus() }
          }}
          className={`px-1 py-2 text-sm border-b-2 ${selected ? 'border-redlog-accent text-redlog-text' : 'border-transparent text-redlog-text-dim hover:text-redlog-text'}`}>
          {t(TAB_LABEL[id])}
          {typeof count === 'number' && <span data-testid={`tab-count-${id}`} className={`ml-1.5 font-mono text-xs tabular-nums ${selected ? 'text-redlog-accent' : 'text-redlog-text-faint'}`}>{count}</span>}
        </button>
      })}
    </div>
  </div>
}
