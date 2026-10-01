// The Timeline's detail panel body: everything shown for the selected event,
// below the resize handle. Moved out of Timeline.tsx (UI/UX audit F13); every
// value arrives as a prop, so — like MarkerDetail — nothing here can read a
// Timeline value before it is declared.

import type { RedLogEvent } from '../../../../core/db/event-types'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { EventNoteField } from './EventNoteField'
import { formatTime } from '../../lib/time'
import { LANE_COLORS, toLane, type EventBadge, type PluginEventType } from '../../lib/timelineDomain'
import type { MarkerFold, MarkerValues } from '../../lib/markerFold'
import { isMarkerAmendment } from '../../lib/markerFold'
import { TierBadge } from '../TierBadge'
import { ReplayCommand } from '../ReplayCommand'
import { CommandEndDetail, AgentTurnDetail, BrowserConsoleDetail } from '../TimelineEventDetails'
import { HttpDetail } from '../HttpDetail'
import { MarkerDetail } from '../MarkerDetail'

type Translate = (key: string, vars?: Record<string, string | number>) => string

export interface TimelineEventInspectorProps {
  event: RedLogEvent
  pluginTypes: PluginEventType[]
  tierChip: boolean
  doNotExport: boolean
  onToggleDoNotExport: () => void
  /** Narrow the shared time filter to a window around this event. */
  onAround: () => void
  operatorLabel: (id: string) => string
  titleOf: (e: RedLogEvent) => string
  badges: EventBadge[] | undefined
  /** Ids of the events that name this one as a cause. */
  effects: string[] | undefined
  fold: MarkerFold | undefined
  paired: { kind: 'call' | 'result'; data: Record<string, unknown> } | undefined
  allLoaded: boolean
  focusChainOn: boolean
  showJson: boolean
  /** A loaded event by id; undefined when it is not paged in. */
  lookup: (id: string) => RedLogEvent | undefined
  /** Select an event and scroll the track to it. */
  onJump: (e: RedLogEvent) => void
  /** Move the selection one row along the list the operator is reading.
   *  Absent when there is no list to walk (a single filtered result). */
  onStep?: (delta: -1 | 1) => void
  canStepPrev?: boolean
  canStepNext?: boolean
  /** Select an event without scrolling. */
  onSelect: (e: RedLogEvent) => void
  /** Fetch an event outside the loaded page and select it. */
  onResolve: (id: string) => void
  scrollToTs: (ts: number) => void
  onAmend: (markerId: string, changes: Partial<MarkerValues>) => void
  t: Translate
}

export function TimelineEventInspector({
  event, pluginTypes, tierChip, doNotExport: dneFlag, onToggleDoNotExport, onAround,
  operatorLabel, titleOf, badges, effects, fold, paired, allLoaded, focusChainOn,
  showJson, lookup, onJump, onSelect, onResolve, scrollToTs, onAmend, t,
  onStep, canStepPrev = false, canStepNext = false
}: TimelineEventInspectorProps): JSX.Element {
  return (
    <>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Reading a capture is reading a sequence — what ran before this,
              what came back after. The keyboard could already walk it, lane by
              lane, and nothing on screen said so: an operator who opened the
              pane from the list had to close it, move, and open the next one.
              These step the list's own order, which is the order they were
              just reading. */}
          {onStep && (
            <span className="flex items-center mr-0.5">
              <button
                type="button"
                data-testid="detail-step-prev"
                disabled={!canStepPrev}
                onClick={() => onStep(-1)}
                title={t('timeline.stepPrev')}
                aria-label={t('timeline.stepPrev')}
                className="w-5 h-5 flex items-center justify-center rounded-l border border-redlog-border/60 bg-redlog-elevated/40 text-redlog-text-dim hover:text-redlog-text hover:border-redlog-border disabled:opacity-35 disabled:hover:text-redlog-text-dim transition-colors"
              ><ChevronLeft size={12} strokeWidth={2} aria-hidden /></button>
              <button
                type="button"
                data-testid="detail-step-next"
                disabled={!canStepNext}
                onClick={() => onStep(1)}
                title={t('timeline.stepNext')}
                aria-label={t('timeline.stepNext')}
                className="w-5 h-5 flex items-center justify-center rounded-r border border-l-0 border-redlog-border/60 bg-redlog-elevated/40 text-redlog-text-dim hover:text-redlog-text hover:border-redlog-border disabled:opacity-35 disabled:hover:text-redlog-text-dim transition-colors"
              ><ChevronRight size={12} strokeWidth={2} aria-hidden /></button>
            </span>
          )}
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: LANE_COLORS[toLane(event.agentType, event.data?.subtype as string | undefined, pluginTypes)] }} />
          <span className="text-xs font-mono font-semibold uppercase tracking-wider" style={{ color: LANE_COLORS[toLane(event.agentType, event.data?.subtype as string | undefined, pluginTypes)] }}>
            {event.agentType}
          </span>
          <span className="text-xs font-mono text-redlog-text-dim px-1.5 py-0.5 rounded bg-redlog-elevated/60" title={event.operatorId}>
            {operatorLabel(event.operatorId)}
          </span>
          <TierBadge tier={event.tier} variant="detail" show={tierChip} />
        </div>
        <div className="flex items-center gap-2">
          {/* "What else was happening when this ran" is the commonest
              next question about an event, and there was no way to ask
              it: the bar offered only windows ending now. */}
          <button
            type="button"
            data-testid="detail-around-event"
            className="text-xs px-1.5 py-0.5 rounded border border-redlog-border/60 bg-redlog-elevated/40 text-redlog-text-dim hover:text-redlog-text hover:border-redlog-border transition-colors"
            title={t('filter.around')}
            onClick={onAround}
          >{t('filter.around')}</button>
          <button
            type="button"
            className={`text-xs font-mono px-1.5 py-0.5 rounded border transition-colors ${
              dneFlag
                ? 'border-red-500/60 bg-red-500/15 text-red-300'
                : 'border-redlog-border/60 bg-redlog-elevated/40 text-redlog-text-dim hover:text-redlog-text hover:border-redlog-border'
            }`}
            title={dneFlag ? t('timeline.doNotExportHint') : t('timeline.doNotExport')}
            onClick={onToggleDoNotExport}
          >
            {dneFlag ? t('timeline.doNotExportActive') : t('timeline.doNotExport')}
          </button>
        </div>
      </div>
      {/* The headline. One thing on this pane is the subject and everything
          else describes it — the command, the METHOD and URL, the marker's
          title. It used to render at the same 13px, the same weight and the
          same colour as the six facts under it, so the eye had nowhere to
          land first and the operator read the panel top to bottom every
          time. `break-all` because a URL with a query string is longer than
          any pane. */}
      <p className="mt-2 font-mono text-sm leading-relaxed text-redlog-text break-all">{titleOf(event)}</p>
      {/* The facts, as label/value rather than prose.
          `目標：10.0.4.12` reads as a sentence and scans as nothing: every
          line began with a different word at a different length, so finding
          the target meant reading all of them. Labels left and dim, values
          right and mono — the values line up, which is what makes a column
          scannable rather than merely present. */}
      <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-redlog-text-faint">{t('timeline.detail.when')}</dt>
        <dd className="font-mono text-redlog-text-dim text-right tabular-nums">
          {formatTime(event.timestamp, { seconds: true })}
        </dd>
        <dt className="text-redlog-text-faint">{t('timeline.detail.source')}</dt>
        <dd className="font-mono text-redlog-text-dim text-right truncate" title={event.hostname}>
          {event.hostname}
        </dd>
        {event.targetId && (
          <>
            <dt className="text-redlog-text-faint">{t('timeline.detail.target')}</dt>
            <dd className="font-mono text-redlog-text-dim text-right truncate" title={event.targetId}>
              {event.targetId}
            </dd>
          </>
        )}
      </dl>
      {/* v0.6.89.5 feature 3: full stacked-row of integrity badges next
          to the title so the operator sees every flag at once (the dot
          overlay only shows the first). Empty when the event has none. */}
      {(() => {
                    if (!badges || badges.length === 0) return null
        return (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {badges.map((b) => (
              <span
                key={b.key}
                className="text-xs px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-200 font-mono"
                title={b.reasonKey ? t(b.reasonKey) : b.reason}
              >
                {b.icon} {b.reasonKey ? t(b.reasonKey) : b.reason}
              </span>
            ))}
          </div>
        )
      })()}
      {/* v0.6.89.5 feature 1: `_causes` visualisation. Chips look up the
          cause in the in-memory events map; a click sets that event as
          the new selection and scrolls the track to centre it. A cause
          id not found in the map is a "chain broken" symptom — the T6
          case from the design grill — and gets a red chip so the
          operator can't miss it. */}
      {(() => {
        const causes = (event.data as { _causes?: unknown } | undefined)?._causes
        if (!Array.isArray(causes) || causes.length === 0) return null
        return (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <span className="text-xs text-redlog-text-dim font-mono">
              {t('timeline.detail.causedBy')}
            </span>
            {(causes as unknown[]).filter((c): c is string => typeof c === 'string').map((cid) => {
              const cev = lookup(cid)
              if (!cev) {
                // Two very different situations wore the same red chip. A
                // cause the panel simply has not paged in yet is normal —
                // an amendment is always newer than the marker it names, so
                // this is the DEFAULT path for one — while 「chain broken」 is
                // the app's most serious claim and must stay rare enough to
                // be believed. Offer to fetch it instead.
                // A retroactive violation cites a source event that is days
                // old and almost never inside the loaded window. Same honest
                // claim as the amendment case: not loaded, not broken.
                const srcTs = (event.data as Record<string, unknown> | undefined)?.source_ts
                if (typeof srcTs === 'number' && srcTs > 0) {
                  return (
                    <button
                      key={cid}
                      type="button"
                      onClick={() => scrollToTs(srcTs)}
                      className="text-xs px-1.5 py-0.5 rounded border border-redlog-border bg-redlog-elevated text-redlog-text-dim hover:text-redlog-text font-mono"
                      title={cid}
                    >
                      {t('timeline.detail.causeNotLoaded', { time: formatTime(srcTs, { seconds: true }) })}
                    </button>
                  )
                }
                if (isMarkerAmendment(event)) {
                  return (
                    <button
                      key={cid}
                      type="button"
                      onClick={() => onResolve(cid)}
                      className="text-xs px-1.5 py-0.5 rounded border border-redlog-border bg-redlog-elevated text-redlog-text-dim hover:text-redlog-text font-mono"
                      title={cid}
                    >
                      {t('timeline.detail.causeUnpaged')}
                    </button>
                  )
                }
                return (
                  <button
                    key={cid}
                    type="button"
                    onClick={() => onResolve(cid)}
                    className="text-xs px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:text-amber-100 font-mono"
                    title={cid}
                  >
                    {t('timeline.detail.causeNotFound', { id: cid.slice(0, 8) })}
                  </button>
                )
              }
              const clane = toLane(cev.agentType, cev.data?.subtype as string | undefined, pluginTypes)
              const cc = LANE_COLORS[clane]
              return (
                <button
                  key={cid}
                  onClick={() => onJump(cev)}
                  className="text-xs px-1.5 py-0.5 rounded font-mono truncate max-w-[280px] hover:brightness-125 transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim"
                  style={{ color: cc, backgroundColor: `${cc}18`, border: `1px solid ${cc}40` }}
                  title={titleOf(cev)}
                >
                  ◂ {titleOf(cev)}
                </button>
              )
            })}
          </div>
        )
      })()}
      {(() => {
        const raw = (event.data as { related_commands?: unknown } | undefined)?.related_commands
        if (!Array.isArray(raw) || raw.length === 0) return null
        const candidates = raw.filter((value): value is { event_id: string; method: string; state: string } => {
          if (!value || typeof value !== 'object') return false
          const candidate = value as Record<string, unknown>
          return typeof candidate.event_id === 'string' && typeof candidate.method === 'string'
        })
        if (candidates.length === 0) return null
        return (
          <div className="mt-1 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1.5">
            <p className="text-xs text-amber-200 font-mono">{t('timeline.detail.relatedCommands')}</p>
            <p className="text-xs text-redlog-text-dim mt-0.5">{t('timeline.detail.relatedCommandsHint')}</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {candidates.map((candidate) => {
                const related = lookup(candidate.event_id)
                const label = related ? titleOf(related) : candidate.event_id.slice(0, 8)
                return (
                  <button
                    key={`${candidate.event_id}:${candidate.method}`}
                    type="button"
                    onClick={() => related ? onJump(related) : onResolve(candidate.event_id)}
                    className="text-xs px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:text-amber-100 font-mono"
                    title={`${candidate.method} · ${candidate.state}`}
                  >
                    ≈ {label} · {t(candidate.state === 'recent' ? 'timeline.detail.relatedRecent' : 'timeline.detail.relatedActive')}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })()}
      {/* Effects (reverse map). Capped at 20 chips; overflow footer says
          how many more without rendering thousands of buttons. */}
      {(() => {
        const eff = effects
        if (!eff || eff.length === 0) return null
        const CAP = 20
        const shown = eff.slice(0, CAP)
        const more = eff.length - shown.length
        return (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <span className="text-xs text-redlog-text-dim font-mono">
              {t('timeline.detail.effects', { count: eff.length })}
            </span>
            {shown.map((eid) => {
              const ev = lookup(eid)
              if (!ev) return null
              const elane = toLane(ev.agentType, ev.data?.subtype as string | undefined, pluginTypes)
              const ec = LANE_COLORS[elane]
              return (
                <button
                  key={eid}
                  onClick={() => onJump(ev)}
                  className="text-xs px-1.5 py-0.5 rounded font-mono truncate max-w-[280px] hover:brightness-125 transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim"
                  style={{ color: ec, backgroundColor: `${ec}18`, border: `1px solid ${ec}40` }}
                  title={titleOf(ev)}
                >
                  ▸ {titleOf(ev)}
                </button>
              )
            })}
            {more > 0 && (
              <span className="text-xs text-redlog-text-dim font-mono">
                {t('timeline.detail.effectsMore', { count: more })}
              </span>
            )}
          </div>
        )
      })()}
      {/* Focus-chain hint bubble (feature 2) — small nudge shown on the
          currently-selected event's detail panel when focus mode is OFF.
          Suppressed entirely once the operator is already in focus mode
          so it doesn't add noise. */}
      {!focusChainOn && (
        <p className="mt-1 text-xs text-redlog-text-faint font-mono">
          {t('timeline.focusChain.enterHint')}
        </p>
      )}
      {/* Structured stdout/stderr + metadata for shell command_end. */}
      {event.agentType === 'shell'
        && event.data?.subtype === 'command_end'
        && (
          <CommandEndDetail data={event.data as Record<string, unknown>} />
        )}
      {/* v0.9.2 U1: agent-turn detail. Body text (user_message /
          assistant_message / thinking) shown open by default via
          CollapsibleStream so the operator sees the prompt/response
          on click without another expand. tool_call renders the
          parsed input JSON; tool_result its output stream. */}
      {event.agentType === 'agent' && (
        <AgentTurnDetail
          data={event.data as Record<string, unknown>}
          paired={paired}
          allLoaded={allLoaded}
        />
      )}
      {/* v0.11.2 (T6): scanner and browser events carried their payloads
          all along — mitmproxy sends request params and a 2 KB
          `response_preview`, CDP sends the console message and stack — but
          neither had a detail body, so the only way to read any of it was
          the raw-JSON toggle: unformatted, redaction-masked, in a 120px
          box. Same treatment as shell and agent events now. */}
      {event.agentType === 'scanner' && (
        <HttpDetail data={event.data as Record<string, unknown>} eventId={event.id} />
      )}
      {event.agentType === 'browser' && (
        <BrowserConsoleDetail data={event.data as Record<string, unknown>} />
      )}
      {event.agentType === 'marker' && (
        <MarkerDetail
          key={event.id}
          event={event}
          fold={fold}
          linkedScreenshots={(effects ?? [])
            .map((id) => lookup(id))
            .filter((e): e is RedLogEvent => !!e && e.agentType === 'screenshot')}
          operatorLabel={operatorLabel}
          onAmend={onAmend}
          onSelect={onSelect}
          onResolveOriginal={onResolve}
        />
      )}
      {/* Replay this command: only for shell.command_end from a builtin
          terminal — pulls the stdout window out of the session's .cast
          file instead of storing it in the chain. */}
      {event.agentType === 'shell'
        && event.data?.subtype === 'command_end'
        && event.data?.source === 'builtin-terminal'
        && (
          <ReplayCommand eventId={event.id} mode="command" />
        )}
      {/* Session-level replay: for session_start / session_end, replays
          the ENTIRE pty session. Critical when the operator ssh'd into
          a remote host — command_end only shows the local `ssh` line;
          session replay shows every keystroke and screen after that. */}
      {event.agentType === 'shell'
        && (event.data?.subtype === 'session_start' || event.data?.subtype === 'session_end')
        && event.data?.source === 'builtin-terminal'
        && (
          <ReplayCommand eventId={event.id} mode="session" />
        )}
      {/* Shown as recorded. See copyJson above — layer 3 display masking
          is gone; layer 4 still redacts everything that leaves. */}
      {showJson && (
        <pre className="mt-2 p-3 bg-redlog-bg rounded border border-redlog-border text-xs text-redlog-text-dim font-mono overflow-x-auto leading-relaxed max-h-[120px] overflow-y-auto">
          {JSON.stringify(event.data, null, 2)}
        </pre>
      )}
      {/* Last, because it is the operator's words about everything above it. */}
      <EventNoteField eventId={event.id} t={t} />
    </>
  )
}
