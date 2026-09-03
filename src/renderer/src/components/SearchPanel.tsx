import { useState, useCallback, useRef, useEffect } from 'react'
import { useListKeyboard } from '../lib/useListKeyboard'
import { useI18n } from '../i18n'
import { formatTime } from '../lib/time'
import { CastResults, type CastHit } from './CastResults'
import { isMarkerAmendment, foldMarker, groupAmendments, amendedFields, type MarkerFold } from '../lib/markerFold'

const TYPE_COLORS: Record<string, string> = {
  shell: 'text-green-400',
  screenshot: 'text-blue-400',
  clipboard: 'text-yellow-400',
  file_transfer: 'text-purple-400',
  marker: 'text-red-400',
  loot: 'text-orange-400',
  system: 'text-redlog-text-dim'
}

function eventSummary(e: RedLogEvent, fold?: MarkerFold): string {
  const d = e.data
  if (e.agentType === 'shell') return `$ ${(d.command as string)?.slice(0, 120) || ''}`
  if (e.agentType === 'screenshot') return `Screenshot (${d.trigger})`
  if (e.agentType === 'clipboard') return `Clipboard: ${(d.content as string)?.slice(0, 80) || ''}`
  if (e.agentType === 'marker') {
    if (isMarkerAmendment(e)) return `↻ ${amendedFields(e).join(' · ')}`
    const eff = fold?.effective
    return `[${eff?.severity ?? d.severity}] ${eff?.title ?? d.title}`
  }
  if (e.agentType === 'file_transfer') return `${d.direction}: ${d.filename || d.localPath || d.remotePath}`
  if (e.agentType === 'loot') return `Loot: ${d.type} (${d.confidence})`
  return `${e.agentType}: ${d.subtype || JSON.stringify(d).slice(0, 60)}`
}

/** Fold every marker in a result page against the amendments fetched for it. */
function buildFolds(rows: RedLogEvent[], amendments: RedLogEvent[]): Map<string, MarkerFold> {
  const byMarker = groupAmendments(amendments)
  const out = new Map<string, MarkerFold>()
  if (byMarker.size === 0) return out
  for (const e of rows) {
    if (e.agentType !== 'marker' || isMarkerAmendment(e)) continue
    const mine = byMarker.get(e.id)
    if (mine) out.set(e.id, foldMarker(e, mine))
  }
  return out
}

/** Compose rather than replace: the hover has to reveal the full DISPLAYED
 *  value (§9), and for a corrected marker it also carries the title the search
 *  actually matched on — otherwise a hit on the old wording looks like a
 *  mismatch. */
function hoverTitle(
  e: RedLogEvent,
  fold: MarkerFold | undefined,
  t: (k: string, v?: Record<string, string | number>) => string
): string {
  const shown = eventSummary(e, fold)
  if (!fold) return shown
  return `${shown}\n${t('search.amendedOriginalTitle', { title: String(e.data.title ?? '') })}`
}

interface SearchPanelProps {
  onOpenInTimeline?: (eventId: string, ts: number) => void
}

export function SearchPanel({ onOpenInTimeline }: SearchPanelProps = {}): JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<RedLogEvent[]>([])
  const [folds, setFolds] = useState<Map<string, MarkerFold>>(new Map())
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  // Type-filter chips: null = show all, non-null = only that agentType. Audit
  // finding #57 — before this, "192.168" matching 200 shell events left no
  // way to say "only screenshots". Kept client-side because the search
  // backend uses full-text LIKE that doesn't take a WHERE agent_type filter.
  const [typeFilter, setTypeFilter] = useState<string | null>(null)
  // Recordings are searched alongside events (§2.4). Kept as separate state
  // rather than merged into `results`: an event and a span of terminal output
  // are not the same kind of thing, and flattening them would mean inventing
  // a summary line for bytes that already have one.
  const [castHits, setCastHits] = useState<CastHit[]>([])
  const [castPending, setCastPending] = useState(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { t } = useI18n()

  // Hoisted out of the render IIFE it used to live in so the keyboard hook can
  // count it. Same keys as every other list (§9); a result row's only action
  // is "show me this on the Timeline", so Enter and ⌘↩ agree.
  const filtered = typeFilter ? results.filter((e) => e.agentType === typeFilter) : results
  const listNav = useListKeyboard({
    count: filtered.length,
    onActivate: (i) => { const e = filtered[i]; if (e) onOpenInTimeline?.(e.id, e.timestamp) },
    onJumpToTimeline: (i) => { const e = filtered[i]; if (e) onOpenInTimeline?.(e.id, e.timestamp) },
    onEscape: () => setTypeFilter(null)
  })

  const doSearch = useCallback((q: string) => {
    // Single-char search intents are real (IP octet, short tag) — down from
    // the prior q<2 gate. 0-char still shows the placeholder hint. Audit P1 #27.
    if (q.length < 1) {
      setResults([])
      setCastHits([])
      setSearched(false)
      return
    }
    setSearching(true)
    window.redlog.events.search(q, 200).then(async (r) => {
      // `searchEvents` is a LIKE over each row's own bytes, so a marker
      // corrected since it was written matches its OLD title only, and the new
      // one matches the amendment row alone. Showing that bare correction —
      // with the finding itself missing from the results — reads as the finding
      // having been deleted, which for this product is the worst possible lie.
      // So an amendment hit is resolved back to the marker it names.
      const markerIds = new Set(r.filter((e) => e.agentType === 'marker' && !isMarkerAmendment(e)).map((e) => e.id))
      const orphaned = r.filter(isMarkerAmendment)
        .map((e) => String((e.data as Record<string, unknown>).markerId ?? ''))
        .filter((id) => id && !markerIds.has(id))
      let rows = r
      if (orphaned.length > 0) {
        const originals = (await window.redlog.events.getById?.([...new Set(orphaned)])) ?? []
        for (const o of originals) markerIds.add(o.id)
        // The correction stays out of the list; the finding takes its place at
        // the position the correction held, so result order still tracks the hit.
        const seen = new Set<string>()
        rows = r.flatMap((e) => {
          if (!isMarkerAmendment(e)) return [e]
          const id = String((e.data as Record<string, unknown>).markerId ?? '')
          const original = originals.find((o) => o.id === id)
          if (!original || seen.has(id)) return []
          seen.add(id)
          return [original]
        })
      }
      const amendments = markerIds.size > 0
        ? (await window.redlog.marker.amendments?.([...markerIds])) ?? []
        : []
      setFolds(buildFolds(rows, amendments))
      setResults(rows)
      setSearching(false)
      setSearched(true)
    })
    // Fired in parallel and settled independently: the recording index can be
    // slower or absent, and making the event results wait on it would slow
    // the common case for the rarer one.
    window.redlog.events.searchCasts?.(q, 50)
      .then((r) => setCastHits(r ?? []))
      .catch(() => setCastHits([]))
  }, [])

  useEffect(() => {
    window.redlog.events.castIndexStatus?.()
      .then((s) => setCastPending(s?.pending ?? 0))
      .catch(() => { /* older main process; treat as fully indexed */ })
  }, [])

  const onChange = useCallback((val: string) => {
    setQuery(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(val), 300)
  }, [doSearch])

  return (
    <div className="p-4 h-full flex flex-col">
      <div className="relative mb-3 shrink-0">
        <input
          value={query}
          data-testid="search-input"
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('search.placeholder')}
          autoFocus
          className="w-full bg-redlog-elevated border border-redlog-border rounded-lg px-4 py-2.5 text-sm text-redlog-text font-mono focus:outline-none focus:border-red-500 placeholder-redlog-text-faint"
        />
        {searching && (
          <span className="absolute right-3 top-3 text-redlog-text-dim text-xs animate-pulse">...</span>
        )}
      </div>

      <div className="flex-1 overflow-auto min-h-0">
        {!searched && !searching && (
          <div className="text-redlog-text-faint text-sm text-center mt-8">
            {t('search.hint')}
          </div>
        )}
        {searched && results.length === 0 && castHits.length === 0 && (
          <div className="text-redlog-text-faint text-sm text-center mt-8">
            {t('search.noResults', { query })}
            {castPending > 0 && (
              <p className="text-xs text-amber-500/80 mt-2" role="status">
                {t('castSearch.stillIndexing', { pending: castPending })}
              </p>
            )}
          </div>
        )}
        {results.length > 0 && (() => {
          // Bucket by agentType so the filter chips can show counts inline.
          const byType = new Map<string, number>()
          for (const e of results) byType.set(e.agentType, (byType.get(e.agentType) ?? 0) + 1)
          const types = [...byType.entries()].sort((a, b) => b[1] - a[1])
          return (
          <>
            <div className="text-redlog-text-dim text-xs mb-2">
              {t('search.results', { count: filtered.length })}
              {typeFilter && <> · <button onClick={() => setTypeFilter(null)} className="text-redlog-text-dim hover:text-redlog-text underline">{t('search.clearFilter')}</button></>}
            </div>
            {types.length > 1 && (
              <div className="flex flex-wrap gap-1 mb-2">
                {types.map(([type, count]) => (
                  <button
                    key={type}
                    onClick={() => setTypeFilter(typeFilter === type ? null : type)}
                    className={`px-2 py-0.5 text-xs font-mono rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 ${
                      typeFilter === type ? 'bg-red-500/20 text-red-300' : 'bg-redlog-elevated text-redlog-text-dim hover:text-redlog-text hover:bg-redlog-elevated-hover'
                    }`}
                  >
                    <span className={TYPE_COLORS[type] || ''}>{type}</span> <span className="text-redlog-text-faint">·{count}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="space-y-1" {...listNav.containerProps} aria-label={t('search.resultsLabel', { count: filtered.length })}>
              {filtered.map((e, i) => {
                const rowProps = listNav.itemProps(i)
                return (
                <button
                  key={e.id}
                  {...rowProps}
                  ref={(el) => rowProps.ref(el)}
                  onClick={() => { rowProps.onClick(); onOpenInTimeline?.(e.id, e.timestamp) }}
                  disabled={!onOpenInTimeline}
                  className="w-full text-left flex items-start gap-2 px-3 py-2 rounded hover:bg-redlog-elevated/50 text-xs disabled:cursor-default disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40"
                  title={onOpenInTimeline ? t('search.openInTimeline') : undefined}
                >
                  <span className={`font-mono font-bold w-12 shrink-0 ${TYPE_COLORS[e.agentType] || 'text-redlog-text-dim'}`}>
                    {e.agentType.slice(0, 6)}
                  </span>
                  <span
                    title={hoverTitle(e, folds.get(e.id), t)}
                    className="text-redlog-text font-mono flex-1 min-w-0 truncate"
                  >
                    {eventSummary(e, folds.get(e.id))}
                  </span>
                  {folds.get(e.id) && (
                    <span
                      data-testid="marker-amend-count"
                      className="text-redlog-text-dim font-mono tabular-nums shrink-0 ml-1"
                      title={t('marker.amendedTimesHint')}
                    >
                      {t('marker.amendedTimes', { count: folds.get(e.id)!.amendCount })}
                    </span>
                  )}
                  <span className="text-redlog-text-faint shrink-0 ml-2">
                    {formatTime(e.timestamp, { seconds: true })}
                  </span>
                  {e.targetId && (
                    <span className="text-redlog-text-dim shrink-0 ml-1">→ {e.targetId}</span>
                  )}
                </button>
                )
              })}
            </div>
          </>
        )})()}

        {searched && (
          <CastResults
            hits={castHits}
            pending={castPending}
            onOpenAt={onOpenInTimeline ? (tMs) => onOpenInTimeline('', tMs) : undefined}
          />
        )}
      </div>
    </div>
  )
}
