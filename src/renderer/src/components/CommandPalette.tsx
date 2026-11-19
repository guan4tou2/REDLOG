import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { flushSync } from 'react-dom'
import { Search } from 'lucide-react'
import { useI18n } from '../i18n'
import type { HostAggregate } from '../../../core/db/events'
import { useFocusTrap } from '../lib/useFocusTrap'
import { DEFAULT_ORDER, primaryLabelKey, NUMBERED_SLOTS } from '../lib/sidebarOrder'
import { applyDensity, resolveDensity, storedDensity, DENSITY_KEY } from '../lib/density'
import { formatWhen, formatFreshness } from '../lib/time'
import { paletteSettingsHits } from '../lib/paletteSettings'
import { settingsTarget } from '../lib/navigation'
import { landOnSetting } from '../lib/settingsFind'
import { parseQuery } from '../../../core/query/contract'
import { configInvalidDetail } from '../../../core/config-invalid'
import { toast } from './Toast'
import { addArtifactsWithFeedback } from '../lib/addArtifacts'
import { flushPendingSaves } from '../lib/pendingSaves'
import { confirmLeaveProject } from '../lib/leaveProject'
import { captureScreenshotWithFeedback } from '../lib/captureScreenshot'
import { toggleRecordingWithFeedback } from '../lib/recordingToggle'
import { MOD } from '../lib/platform'
import { isComposing } from '../lib/ime'

// ⌘K — the jumper.
//
// ⌘K used to mean two different things depending on where you were: the
// Timeline's own fuzzy palette there, the Search page everywhere else. So an
// operator had to know which surface they were on to know what the key did,
// while navigation, project switching and every app-level action had no
// keyboard route at all. This is the same palette on every view.
//
// It is deliberately *not* the search surface. A dropdown is the right shape
// for "take me to that one thing" and the wrong shape for "show me everything
// matching, let me filter it and read it" — which is what after-action review
// actually asks: which files did the agent touch, what happened on this host,
// which commands failed in those two hours. Those are not jumps. The Search
// view is the explorer; ⌘K reaches it like anything else.
//
// In-page filtering is ⌘F, the convention every other desktop app has already
// taught.

type Kind = 'nav' | 'action' | 'project' | 'operator' | 'host' | 'setting' | 'search'

interface Item {
  id: string
  kind: Kind
  label: string
  /** Mark the part of the label the query matched. Event rows are found by the
   *  store's query language, not by this substring, so they are not marked. */
  mark: boolean
  /** Right-hand detail: a shortcut, a timestamp, a path. */
  hint?: string
  run: () => void
}

const KIND_KEY: Record<Kind, string> = {
  nav: 'palette.kindPage',
  action: 'palette.kindAction',
  project: 'palette.kindProject',
  operator: 'palette.kindOperator',
  host: 'palette.kindHost',
  setting: 'palette.kindSetting',
  search: 'palette.kindEvent'
}

// A kind is listed once, in this order; the score only orders rows inside it.
// With nothing typed the menu leads with what the operator does, not with the
// pages the sidebar already lists. Hosts, settings and events wait for a query.
// Inside the actions the recording toggle is not first: Enter on an empty
// query must not pause capture (owner, 2026-11-19).
const ORDER_TYPED: Kind[] = ['nav', 'action', 'project', 'operator', 'host', 'setting', 'search']
const ORDER_EMPTY: Kind[] = ['action', 'project', 'nav', 'operator']

/** Settings rows shown for one query; the rest are said, not hidden. */
const SETTINGS_LIMIT = 8

function Marked({ text, query }: { text: string; query: string }): JSX.Element {
  const i = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-transparent text-redlog-text underline underline-offset-2">{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  )
}

/** Newest event matches the palette lists; Search has them all. */
const EVENT_LIMIT = 40

/** Case-insensitive substring score: earlier match wins, then shorter
 *  haystack. Deliberately not a fuzzy matcher — these are literal identifiers (view names, hosts, commands)
 *  and gap tolerance only adds noise. */
function score(haystack: string, needle: string): number {
  if (!needle) return 1
  const i = haystack.toLowerCase().indexOf(needle.toLowerCase())
  if (i < 0) return 0
  return 1000 - i * 10 - Math.min(haystack.length, 99) / 100
}

export interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  onNavigate: (view: string) => void
  onOpenEvent: (id: string, ts: number) => void
  recording: boolean | null
  onProjectClosed?: () => void
}


// Switching project from the palette has the same obligations as closing one
// from the title bar (#223): write pending settings to THIS project first,
// and say so when the switch cannot happen instead of reloading regardless.
//
// And the same question first. Opening another project closes this one through
// the same `stopProject()` — the panes go with it — so a switch that is one
// keystroke away in a fuzzy list is the entry point that most needed asking,
// not the one that could skip it.
async function switchProject(
  target: { id: string; name: string },
  t: (k: string, v?: Record<string, string | number>) => string,
  onProjectClosed?: () => void
): Promise<void> {
  const current = await window.redlog.project.active().catch(() => null)
  // No active project means nothing is being stopped; the picker's own flow
  // does not ask either.
  if (current && !(await confirmLeaveProject(t, { projectName: current.name, to: target.name }))) return
  if (!(await flushPendingSaves())) { toast(t('app.closeSaveFailed'), 'error'); return }
  try {
    const opened = await window.redlog.project.open(target.id)
    if (!opened) { toast(t('project.openMissing'), { type: 'error', why: t('project.openMissingWhy') }); return }
    window.location.reload()
  } catch (err) {
    // Main may have closed the old DB before the new one failed. Reflect the
    // rollback in the workspace while keeping the error toast visible.
    if (await window.redlog.project.active().catch(() => undefined) === null) {
      // Mount the picker's toast container before publishing the failure.
      flushSync(() => onProjectClosed?.())
    }
    const message = err instanceof Error ? err.message : String(err)
    const configFile = configInvalidDetail(message)
    toast(t('project.openFailedTitle'), { type: 'error', why: configFile ? t('project.openFailedConfigWhy') : t('project.openFailedWhy'), detail: configFile ?? message })
  }
}

const NO_EVENTS: RedLogEvent[] = []

export function CommandPalette({
  open, onClose, onNavigate, onOpenEvent, recording, onProjectClosed
}: CommandPaletteProps): JSX.Element | null {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [events, setEvents] = useState<RedLogEvent[]>([])
  // An empty result list means three different things, and only one of them
  // is "nothing matched". The palette says which.
  const [searchState, setSearchState] = useState<'idle' | 'answered' | 'failed' | 'unparsable'>('idle')
  // The query the search state above answers. Until it is the current one,
  // the search is still out, and an empty list is not "nothing matches".
  const [answeredFor, setAnsweredFor] = useState<string | null>(null)
  // Constitution IV: the palette lists the newest EVENT_LIMIT matches and says
  // so when the store has more.
  const [eventsHasMore, setEventsHasMore] = useState(false)
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  // The open project is not a switch target: choosing it would close and reopen it.
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [operators, setOperators] = useState<OperatorInfo[]>([])
  const [hosts, setHosts] = useState<HostAggregate[]>([])
  const panel = useRef<HTMLDivElement | null>(null)
  const field = useRef<HTMLInputElement | null>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The query most recently typed. An answer for any other is dropped: two
  // searches can be out at once and answer in either order.
  const latestQuery = useRef('')

  useFocusTrap(panel, open, field)

  // Reset on every open: a palette that remembers last time's query makes the
  // operator delete something before they can type.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setCursor(0)
    setEvents([])
    setAnsweredFor(null)
    window.redlog.project.list().then(setProjects).catch(() => {})
    window.redlog.project.active().then((p) => setActiveProjectId(p?.id ?? null)).catch(() => setActiveProjectId(null))
    // §10 lists operator among what ⌘K covers. It needs no aggregation and no
    // loaded timeline — `operators:list` is a plain registry read, which is
    // why this half could land ahead of host search.
    window.redlog.operators.list().then(setOperators).catch(() => {})
    // §10 host search: distinct hosts, aggregated in SQL (#65's pattern).
    window.redlog.events.distinctHosts().then(setHosts).catch(() => {})
  }, [open])

  // Event search is the only part that costs anything, so it is the only part
  // that waits.
  useEffect(() => {
    if (!open) return
    if (debounce.current) clearTimeout(debounce.current)
    const q = query.trim()
    latestQuery.current = q
    if (q.length < 2) { setEvents([]); setSearchState('idle'); return }
    debounce.current = setTimeout(() => {
      // Spec 026: the same query language as Search and the Transcript, so a
      // query learned there means the same thing here. A half-typed condition
      // never becomes a store query; a failed query is not an empty result.
      const outcome = parseQuery(q)
      if (!outcome.ok) { setEvents([]); setSearchState('unparsable'); setAnsweredFor(q); return }
      window.redlog.events.runQuery({ parsed: outcome.parsed, limit: EVENT_LIMIT })
        .then((page) => {
          if (latestQuery.current !== q) return
          setEvents(page.items); setEventsHasMore(page.hasMore); setSearchState('answered'); setAnsweredFor(q)
        })
        .catch(() => {
          if (latestQuery.current !== q) return
          setEvents([]); setSearchState('failed'); setAnsweredFor(q)
        })
    }, 140)
    return () => { if (debounce.current) clearTimeout(debounce.current) }
  }, [query, open])

  // Everything the search state holds belongs to `answeredFor`; under any
  // other query it is the last query's, and is not shown.
  const searchPending = query.trim().length >= 2 && answeredFor !== query.trim()
  const shownEvents = searchPending ? NO_EVENTS : events
  const shownSearchState = searchPending ? 'idle' : searchState

  // Settings text is local and cheap to search, so it needs no debounce, but a
  // single character matches too much to be a jump.
  const trimmed = query.trim()
  const { hits: settingsHits, hasMore: settingsHasMore } = useMemo(
    () => (trimmed.length >= 2
      ? paletteSettingsHits(trimmed, t, window.redlog.platform, SETTINGS_LIMIT)
      : { hits: [], hasMore: false }),
    [trimmed, t]
  )

  const items = useMemo<Item[]>(() => {
    const q = query.trim()
    const out: Item[] = []
    const add = (item: Omit<Item, 'mark'> & { mark?: boolean }): void => { out.push({ mark: true, ...item }) }

    for (const [i, view] of DEFAULT_ORDER.entries()) {
      add({
        id: `nav:${view}`, kind: 'nav', label: t(primaryLabelKey(view)),
        // Only primary workspaces are numbered. ⌘9 belongs to Settings, which is
        // pinned outside the reorderable run — the ninth sidebar row has no
        // chord, and claiming one here would advertise a key that does
        // something else.
        hint: i < NUMBERED_SLOTS ? `${MOD}${i + 1}` : undefined,
        run: () => onNavigate(view)
      })
    }
    for (const view of ['transcript', 'scope', 'loot', 'bookmarks']) add({ id: `nav:${view}`, kind: 'nav', label: t(`sidebar.${view}`), run: () => onNavigate(view) })
    add({ id: 'nav:settings', kind: 'nav', label: t('sidebar.settings'), hint: `${MOD}9`, run: () => onNavigate('settings') })

    add({ id: 'action:screenshot', kind: 'action', label: t('screenshots.captureNow'), run: () => { void captureScreenshotWithFeedback(t) } })
    add({ id: 'action:addArtifact', kind: 'action', label: t('artifacts.add'), run: () => { void addArtifactsWithFeedback(t, onOpenEvent) } })
    if (recording !== null) add({
      id: 'action:recording', kind: 'action',
      label: recording ? t('palette.pauseRecording') : t('palette.resumeRecording'),
      hint: `${MOD}.`,
      run: () => { void toggleRecordingWithFeedback(t) }
    })

    const density = resolveDensity(1, storedDensity())
    add({
      id: 'view:density', kind: 'action',
      label: density === 'tight' ? t('palette.densityComfortable') : t('palette.densityTight'),
      run: () => {
        const next = density === 'tight' ? 'comfortable' : 'tight'
        try { localStorage.setItem(DENSITY_KEY, next) } catch { /* quota */ }
        applyDensity(next)
      }
    })

    for (const p of projects.filter((q) => q.id !== activeProjectId).slice(0, 8)) {
      add({
        id: `project:${p.id}`, kind: 'project',
        label: p.name, hint: formatFreshness(p.lastOpened, t),
        run: () => { void switchProject({ id: p.id, name: p.name }, t, onProjectClosed) }
      })
    }

    for (const op of operators) {
      if (op.revokedAt) continue
      add({
        id: `operator:${op.id}`, kind: 'operator',
        label: op.name,
        hint: op.isPrimary ? t('palette.operatorPrimary') : undefined,
        // Filtering the timeline by operator is the question worth asking of
        // one: "what did this person do".
        run: () => { onNavigate('timeline'); setTimeout(() => window.dispatchEvent(new CustomEvent('redlog:filter-operator', { detail: op.id })), 0) }
      })
    }

    // §10: host search. Selecting one lands on the Timeline filtered to that
    // host — the after-action question "what happened on this host". The
    // busiest hosts sort first (the aggregation orders by count).
    for (const h of hosts) {
      add({
        id: `host:${h.host}`, kind: 'host',
        label: h.host,
        hint: t('palette.hostHits', { count: h.count }),
        run: () => { onNavigate('timeline'); setTimeout(() => window.dispatchEvent(new CustomEvent('redlog:filter-host', { detail: h.host })), 0) }
      })
    }

    for (const h of settingsHits) {
      add({
        id: `setting:${h.page}:${h.key}`, kind: 'setting', label: h.text,
        run: () => { onNavigate(settingsTarget(h.page)); landOnSetting(h.page, h.key, h.text) }
      })
    }

    for (const e of shownEvents) {
      const d = e.data as Record<string, unknown> | undefined
      const label = String(d?.command ?? d?.title ?? d?.url ?? d?.description ?? e.agentType)
      add({
        id: `search:${e.id}`, kind: 'search', mark: false,
        label, hint: formatWhen(e.timestamp, { seconds: true }),
        run: () => onOpenEvent(e.id, e.timestamp)
      })
    }

    const rank = (kind: Kind): number => (q ? ORDER_TYPED : ORDER_EMPTY).indexOf(kind)
    if (!q) {
      // With no query, the search, host and settings kinds stay hidden and the
      // rest is a menu. Hosts can number in the hundreds — they belong behind a
      // query, like event search, not in the empty menu.
      return out.filter((i) => rank(i.kind) >= 0).sort((a, b) => rank(a.kind) - rank(b.kind))
    }
    // Array.prototype.sort is stable: rows of equal score keep their own order,
    // which is how events stay newest-first.
    return out
      // A settings row was matched by the settings index, and is listed whatever
      // this substring score makes of it: a hit the count already includes must
      // not vanish here, or the "more match" line would be said over a short list.
      .map((i) => ({ i, s: i.kind === 'search' ? 900 : i.kind === 'setting' ? Math.max(1, score(i.label, q)) : score(i.label, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => rank(a.i.kind) - rank(b.i.kind) || b.s - a.s)
      .map((x) => x.i)
  }, [query, shownEvents, settingsHits, projects, activeProjectId, operators, hosts, recording, t, onNavigate, onOpenEvent, onProjectClosed])

  useEffect(() => { setCursor(0) }, [query])
  // Keep the keyboard selection on screen: ↓ past the fold used to move an
  // invisible highlight.
  useEffect(() => {
    if (!open) return
    document.getElementById(`palette-opt-${cursor}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [cursor, open])

  const activate = useCallback((item: Item | undefined) => {
    if (!item) return
    onClose()
    item.run()
  }, [onClose])

  if (!open) return null

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // An input method owns Enter, Escape and the arrows while it composes.
    if (isComposing(e)) return
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(items.length - 1, c + 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); return }
    if (e.key === 'Enter') { e.preventDefault(); activate(items[cursor]) }
  }

  return (
    <div
      className="fixed inset-0 z-[150] flex items-start justify-center pt-[12vh] bg-black/50 select-text"
      onClick={onClose}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.title')}
        className="w-full max-w-xl mx-4 bg-redlog-surface border border-redlog-border rounded-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 px-3 border-b border-redlog-border">
          <Search size={16} strokeWidth={1.5} aria-hidden className="text-redlog-text-faint shrink-0" />
          <input
            ref={field}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('palette.placeholder')}
            aria-label={t('palette.placeholder')}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-listbox"
            aria-activedescendant={items.length > 0 ? `palette-opt-${cursor}` : undefined}
            autoComplete="off"
            spellCheck={false}
            className="flex-1 bg-transparent py-3 text-sm text-redlog-text placeholder-redlog-muted outline-none"
          />
        </div>

        <div id="palette-listbox" role="listbox" aria-label={t('palette.title')} className="max-h-[52vh] overflow-y-auto py-1">
          {shownSearchState === 'failed' && (
            <p data-testid="palette-search-failed" role="status" className="px-4 py-3 text-xs text-red-300 text-center">
              {t('palette.searchFailed')}
            </p>
          )}
          {shownSearchState === 'unparsable' && (
            <p data-testid="palette-search-unparsable" role="status" className="px-4 py-3 text-xs text-amber-300 text-center">
              {t('palette.searchUnparsable')}
            </p>
          )}
          {shownSearchState === 'answered' && eventsHasMore && (
            <p data-testid="palette-search-subset" role="status" className="px-4 py-2 text-xs text-redlog-text-faint">
              {t('palette.searchSubset', { count: EVENT_LIMIT })}
            </p>
          )}
          {settingsHasMore && (
            <p data-testid="palette-settings-subset" role="status" className="px-4 py-2 text-xs text-redlog-text-faint">
              {t('palette.settingsSubset')}
            </p>
          )}
          {items.length === 0 && !searchPending && shownSearchState !== 'failed' && shownSearchState !== 'unparsable' && (
            <p className="px-4 py-6 text-xs text-redlog-text-faint text-center">
              {t('palette.noMatches', { query })}
            </p>
          )}
          {items.map((item, i) => (
            <button
              key={item.id}
              id={`palette-opt-${i}`}
              data-command-id={item.id}
              data-kind={item.kind}
              role="option"
              aria-selected={i === cursor}
              onMouseMove={() => setCursor(i)}
              onClick={() => activate(item)}
              className={`w-full flex items-center gap-3 px-3 py-1.5 text-left ${
                i === cursor ? 'bg-redlog-elevated' : ''
              }`}
            >
              <span data-testid="palette-where" className="w-14 shrink-0 text-xs text-redlog-text-faint">{t(KIND_KEY[item.kind])}</span>
              <span title={item.label} className="flex-1 min-w-0 truncate text-xs text-redlog-text">
                {item.mark ? <Marked text={item.label} query={trimmed} /> : item.label}
              </span>
              {item.hint && (
                <span className="shrink-0 text-xs font-mono text-redlog-text-faint tabular-nums">{item.hint}</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
