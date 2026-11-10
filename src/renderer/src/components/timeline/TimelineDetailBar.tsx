// The Timeline's bottom bar (Stitch 05): one compact summary of the selected
// event, always shown while something is selected. It carries the event's
// identity, the facts it really has, and the ways on from it. The Inspector
// body (causal links, per-type detail, notes, ...) opens separately.

import { useEffect, useState } from 'react'
import { Button } from '../Button'
import { writeClipboard } from '../../lib/clipboard'
import { toast } from '../Toast'
import { classifyScope } from '../../../../core/scope-evaluator'
import type { RedLogEvent } from '../../../../core/db/event-types'
import { formatTime } from '../../lib/time'
import { LANE_LABEL_KEYS, toLane, type PluginEventType } from '../../lib/timelineDomain'
import { hasContentReader } from '../../lib/timelineEvents'

type Translate = (key: string, vars?: Record<string, string | number>) => string
type ScopePolicy = { targets: string[]; excludeTargets: string[] }

/** `undefined` while the policy is being read; `null` when it could not be.
 *  Not read at all for an event with no target, and read again when the scope
 *  changes (as the HTTP log does). */
function useScopePolicy(wanted: boolean): ScopePolicy | null | undefined {
  const [policy, setPolicy] = useState<ScopePolicy | null | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!wanted) return
    let live = true
    new Promise<ScopePolicy | null>((resolve) => resolve(window.redlog.scope.policy()))
      .then((p) => { if (live) setPolicy(p ?? null) }, () => { if (live) setPolicy(null) })
    return () => { live = false }
  }, [wanted, attempt])
  useEffect(() => {
    if (!wanted) return
    try {
      return window.redlog.events.onNewBatch((events) => {
        if (events.some((e) => e.data?.subtype === 'config_changed' || e.data?.subtype === 'scope_recomputed')) setAttempt((n) => n + 1)
      })
    } catch { return undefined }
  }, [wanted])
  return policy
}

/** FR-002: no declared scope is "not judged yet", never out of scope. */
function scopeStateKey(target: string, policy: ScopePolicy | null | undefined): string | null {
  if (policy === undefined) return null
  if (policy === null) return 'httpScope.unknown'
  const status = classifyScope(target, policy).status
  if (status === 'in-scope') return 'targets.inScope'
  if (status === 'no-scope') return 'timeline.bar.scopeUnjudged'
  return 'httpScope.out-of-scope'
}

const SEP = <span aria-hidden="true" className="text-redlog-text-faint"> · </span>

export function TimelineDetailBar({
  event, pluginTypes, titleOf, onStep, canStepPrev, canStepNext, onOpenInActivity,
  bodyOpen, onToggleBody, onOpenReader, t
}: {
  event: RedLogEvent
  pluginTypes: PluginEventType[]
  titleOf: (e: RedLogEvent) => string
  onStep?: (delta: -1 | 1) => void
  canStepPrev: boolean
  canStepNext: boolean
  onOpenInActivity?: (eventId: string, ts: number) => void
  bodyOpen: boolean
  onToggleBody: () => void
  onOpenReader: () => void
  t: Translate
}): JSX.Element {
  const policy = useScopePolicy(!!event.targetId)
  const lane = toLane(event.agentType, event.data?.subtype as string | undefined, pluginTypes)
  const exit = event.data?.exit_code
  const duration = event.data?.duration_sec
  const pid = event.data?.pid
  const stateKey = event.targetId ? scopeStateKey(event.targetId, policy) : null
  const facts: JSX.Element[] = []
  if (typeof exit === 'number') {
    facts.push(<span key="exit">{t('timeline.detail.exit')} <span data-testid="detail-exit" className={exit === 0 ? '' : 'text-amber-400'}>{exit}</span></span>)
  }
  if (typeof duration === 'number') facts.push(<span key="dur">{t('timeline.detail.duration')} {duration} s</span>)
  if (typeof pid === 'number') facts.push(<span key="pid">PID: {pid}</span>)
  if (event.targetId) {
    facts.push(
      <span key="target" title={event.targetId} className="min-w-0 truncate">
        {t('timeline.detail.target')}: {event.targetId}
        {stateKey && <> ({t('timeline.bar.scope', { state: t(stateKey) })})</>}
      </span>
    )
  }
  return (
    <div
      data-testid="timeline-detail-panel"
      className="shrink-0 border-t border-redlog-border/50 bg-redlog-surface/80 px-4 py-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5"
    >
      <div className="min-w-0 flex-1 basis-64 text-xs">
        <p className="font-mono truncate" title={`${formatTime(event.timestamp, { seconds: true })} · ${t(LANE_LABEL_KEYS[lane])} · ${titleOf(event)}`}>
          <span className="tabular-nums text-redlog-text-dim">{formatTime(event.timestamp, { seconds: true })}</span>
          {SEP}<span className="text-redlog-text-dim">{t(LANE_LABEL_KEYS[lane])}</span>
          {SEP}<span data-testid="timeline-bar-title" className="text-redlog-text">{titleOf(event)}</span>
        </p>
        {facts.length > 0 && (
          <p data-testid="timeline-bar-facts" className="mt-0.5 flex items-center gap-x-1.5 font-mono text-redlog-text-faint min-w-0">
            {facts.map((f, i) => <span key={i} className={`flex items-center gap-x-1.5 ${i === facts.length - 1 ? 'min-w-0' : 'shrink-0'}`}>{i > 0 && SEP}{f}</span>)}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 ml-auto">
        {onStep && (
          <>
            <Button size="compact" level="quiet" type="button" data-testid="detail-step-prev" disabled={!canStepPrev} onClick={() => onStep(-1)}>{t('timeline.stepPrev')}</Button>
            <Button size="compact" level="quiet" type="button" data-testid="detail-step-next" disabled={!canStepNext} onClick={() => onStep(1)}>{t('timeline.stepNext')}</Button>
          </>
        )}
        <Button size="compact" level="quiet" type="button" data-testid="detail-copy-ref"
          onClick={() => { void writeClipboard(`event:${event.id}`).then((ok) => ok ? toast(t('common.copied'), 'success') : toast(t('common.copyFailed'), 'error')) }}
        >{t('timeline.copyRef')}</Button>
        {hasContentReader(event) && (
          <Button size="compact" level="quiet" type="button" data-testid="detail-open-reader" onClick={onOpenReader}>{t('timeline.bar.reader')}</Button>
        )}
        {onOpenInActivity && (
          <Button size="compact" level="quiet" type="button" data-testid="detail-open-activity"
            onClick={() => onOpenInActivity(event.id, event.timestamp)}
          >{t('timeline.openInActivity')} ↗</Button>
        )}
        <Button size="compact" level="secondary" type="button" data-testid="detail-toggle-body" aria-expanded={bodyOpen} onClick={onToggleBody}>{t('timeline.bar.details')}</Button>
      </div>
    </div>
  )
}
