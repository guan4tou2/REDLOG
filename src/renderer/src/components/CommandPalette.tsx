import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  Gauge, ChevronRight, Rows3, AlignLeft, Image, Crosshair, Ban, Gem, Flag,
  Settings as SettingsIcon, Search, Play, Pause, FolderOpen, Rows2, UserRound, type LucideIcon
} from 'lucide-react'
import { useI18n } from '../i18n'
import { useFocusTrap } from '../lib/useFocusTrap'
import { DEFAULT_ORDER, NUMBERED_SLOTS } from '../lib/sidebarOrder'
import { applyDensity, resolveDensity, storedDensity, DENSITY_KEY } from '../lib/density'
import { formatTime } from '../lib/time'
import { toast } from './Toast'
import { MOD } from '../lib/platform'

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

type Section = 'nav' | 'action' | 'view' | 'project' | 'operator' | 'search'

interface Item {
  id: string
  section: Section
  icon: LucideIcon
  label: string
  /** Right-hand detail: a shortcut, a timestamp, a path. */
  hint?: string
  run: () => void
}

// ⌘9 is Settings', so the sidebar's numbered run stops at eight — read from
// sidebarOrder so the palette cannot advertise a chord the sidebar does not.
// Same detection App uses; read defensively because this module is imported
// in tests where the preload bridge may be absent.


const NAV_ICONS: Record<string, LucideIcon> = {
  dashboard: Gauge, terminal: ChevronRight, timeline: Rows3, transcript: AlignLeft,
  screenshots: Image, targets: Crosshair, scope: Ban, loot: Gem, marks: Flag
}

const SECTION_KEY: Record<Section, string> = {
  nav: 'palette.sectionNav',
  action: 'palette.sectionAction',
  view: 'palette.sectionView',
  project: 'palette.sectionProject',
  operator: 'palette.sectionOperator',
  search: 'palette.sectionSearch'
}

/** Case-insensitive subsequence-free substring score, same rule the Timeline's
 *  palette uses: earlier match wins, then shorter haystack. Deliberately not a
 *  fuzzy matcher — these are literal identifiers (view names, hosts, commands)
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
  recording: boolean
}

export function CommandPalette({
  open, onClose, onNavigate, onOpenEvent, recording
}: CommandPaletteProps): JSX.Element | null {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [events, setEvents] = useState<RedLogEvent[]>([])
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [operators, setOperators] = useState<OperatorInfo[]>([])
  const panel = useRef<HTMLDivElement | null>(null)
  const field = useRef<HTMLInputElement | null>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  useFocusTrap(panel, open, field)

  // Reset on every open: a palette that remembers last time's query makes the
  // operator delete something before they can type.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setCursor(0)
    setEvents([])
    window.redlog.project.list().then(setProjects).catch(() => {})
    // §10 lists operator among what ⌘K covers. It needs no aggregation and no
    // loaded timeline — `operators:list` is a plain registry read, which is
    // why this half could land ahead of host search.
    window.redlog.operators.list().then(setOperators).catch(() => {})
  }, [open])

  // Event search is the only part that costs anything, so it is the only part
  // that waits.
  useEffect(() => {
    if (!open) return
    if (debounce.current) clearTimeout(debounce.current)
    const q = query.trim()
    if (q.length < 2) { setEvents([]); return }
    debounce.current = setTimeout(() => {
      window.redlog.events.search(q, 40).then(setEvents).catch(() => setEvents([]))
    }, 140)
    return () => { if (debounce.current) clearTimeout(debounce.current) }
  }, [query, open])

  const items = useMemo<Item[]>(() => {
    const q = query.trim()
    const out: Item[] = []

    for (const [i, view] of DEFAULT_ORDER.entries()) {
      const label = t(`sidebar.${view === 'screenshots' ? 'screens' : view}`)
      out.push({
        id: `nav:${view}`, section: 'nav', icon: NAV_ICONS[view] ?? Gauge, label,
        // Only the first eight are numbered. ⌘9 belongs to Settings, which is
        // pinned outside the reorderable run — the ninth sidebar row has no
        // chord, and claiming one here would advertise a key that does
        // something else.
        hint: i < NUMBERED_SLOTS ? `${MOD}${i + 1}` : undefined,
        run: () => onNavigate(view)
      })
    }
    out.push({
      id: 'nav:settings', section: 'nav', icon: SettingsIcon,
      label: t('sidebar.settings'), hint: `${MOD}9`, run: () => onNavigate('settings')
    })

    out.push({
      id: 'action:recording', section: 'action', icon: recording ? Pause : Play,
      label: recording ? t('palette.pauseRecording') : t('palette.resumeRecording'),
      hint: `${MOD}.`,
      run: () => { void window.redlog.recording.toggle() }
    })
    out.push({
      id: 'action:screenshot', section: 'action', icon: Image,
      label: t('screenshots.captureNow'),
      run: () => {
        void window.redlog.screenshot.capture().then(() => toast(t('palette.screenshotTaken'), 'success'))
      }
    })

    // The Timeline keeps a palette scoped to the events it has loaded, which
    // knows about lanes, operators and hosts in a way a database search does
    // not. ⌘K used to open it; now that ⌘K is global, this is how it stays
    // reachable — rather than leaving a working feature with no way in.
    out.push({
      id: 'action:timelinePalette', section: 'action', icon: Search,
      label: t('palette.timelineScoped'),
      run: () => {
        onNavigate('timeline')
        // After the view switch, so the Timeline is mounted to hear it.
        setTimeout(() => window.dispatchEvent(new CustomEvent('redlog-timeline-palette')), 0)
      }
    })

    const density = resolveDensity(1, storedDensity())
    out.push({
      id: 'view:density', section: 'view', icon: Rows2,
      label: density === 'tight' ? t('palette.densityComfortable') : t('palette.densityTight'),
      run: () => {
        const next = density === 'tight' ? 'comfortable' : 'tight'
        try { localStorage.setItem(DENSITY_KEY, next) } catch { /* quota */ }
        applyDensity(next)
      }
    })

    for (const p of projects.slice(0, 8)) {
      out.push({
        id: `project:${p.id}`, section: 'project', icon: FolderOpen,
        label: p.name, hint: formatTime(p.lastOpened),
        run: () => { void window.redlog.project.open(p.id).then(() => window.location.reload()) }
      })
    }

    for (const op of operators) {
      if (op.revokedAt) continue
      out.push({
        id: `operator:${op.id}`, section: 'operator', icon: UserRound,
        label: op.name,
        hint: op.isPrimary ? t('palette.operatorPrimary') : undefined,
        // Filtering the timeline by operator is the question worth asking of
        // one: "what did this person do".
        run: () => { onNavigate('timeline'); setTimeout(() => window.dispatchEvent(new CustomEvent('redlog:filter-operator', { detail: op.name })), 0) }
      })
    }

    for (const e of events) {
      const d = e.data as Record<string, unknown> | undefined
      const label = String(d?.command ?? d?.title ?? d?.url ?? d?.description ?? e.agentType)
      out.push({
        id: `search:${e.id}`, section: 'search', icon: Search,
        label, hint: formatTime(e.timestamp, { seconds: true }),
        run: () => onOpenEvent(e.id, e.timestamp)
      })
    }

    if (!q) {
      // With no query, the search section is empty and the rest is a menu.
      return out.filter((i) => i.section !== 'search')
    }
    return out
      .map((i) => ({ i, s: i.section === 'search' ? 900 : score(i.label, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.i)
  }, [query, events, projects, operators, recording, t, onNavigate, onOpenEvent])

  useEffect(() => { setCursor(0) }, [query])

  const activate = useCallback((item: Item | undefined) => {
    if (!item) return
    onClose()
    item.run()
  }, [onClose])

  if (!open) return null

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(items.length - 1, c + 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); return }
    if (e.key === 'Enter') { e.preventDefault(); activate(items[cursor]) }
  }

  let lastSection: Section | null = null

  return (
    <div
      className="fixed inset-0 z-[150] flex items-start justify-center pt-[12vh] bg-black/50 backdrop-blur-sm select-text"
      onClick={onClose}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.title')}
        className="w-full max-w-xl mx-4 bg-redlog-surface border border-redlog-border rounded-xl shadow-2xl overflow-hidden"
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
            autoComplete="off"
            spellCheck={false}
            className="flex-1 bg-transparent py-3 text-sm text-redlog-text placeholder-redlog-muted outline-none"
          />
        </div>

        <div role="listbox" aria-label={t('palette.title')} className="max-h-[52vh] overflow-y-auto py-1">
          {items.length === 0 && (
            <p className="px-4 py-6 text-xs text-redlog-text-faint text-center">
              {t('palette.noMatches', { query })}
            </p>
          )}
          {items.map((item, i) => {
            const header = item.section !== lastSection ? item.section : null
            lastSection = item.section
            return (
              <div key={item.id}>
                {header && (
                  <p className="px-3 pt-2 pb-1 text-xs font-semibold text-redlog-text-faint uppercase tracking-wider">
                    {t(SECTION_KEY[header])}
                  </p>
                )}
                <button
                  role="option"
                  aria-selected={i === cursor}
                  onMouseMove={() => setCursor(i)}
                  onClick={() => activate(item)}
                  className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left ${
                    i === cursor ? 'bg-redlog-elevated' : ''
                  }`}
                >
                  <item.icon size={16} strokeWidth={1.5} aria-hidden className="shrink-0 text-redlog-text-faint" />
                  <span title={item.label} className="flex-1 min-w-0 truncate text-xs text-redlog-text">{item.label}</span>
                  {item.hint && (
                    <span className="shrink-0 text-xs font-mono text-redlog-text-faint tabular-nums">{item.hint}</span>
                  )}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
