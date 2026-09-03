// The Inspector body for a marker (design turn 8b).
//
// Amending is a first-level action with no undo, and that is deliberate: the
// undo IS another amendment, because a correction that could be taken back
// silently would be an edit wearing a different name. So there is no confirm
// dialog and no undo toast — write it, and if it was wrong, write again.
//
// Everything arrives as props. No hook here reads a value from Timeline's body,
// so this component cannot participate in the temporal-dead-zone crash that has
// caught that file twice.

import { useState, useRef, useEffect, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useI18n } from '../i18n'
import { formatTs, type TzMode } from '../lib/time'
import { Button } from './Button'
import {
  MARKER_SEVERITIES, AMENDABLE_FIELDS, amendedFields, isMarkerAmendment,
  diffAgainst, type MarkerFold, type MarkerValues
} from '../lib/markerFold'
import type { RedLogEvent } from '../../../core/db/events'

export interface MarkerDetailProps {
  event: RedLogEvent
  /** Absent when this marker has never been amended. */
  fold: MarkerFold | undefined
  /** Screenshot events that name this marker as their cause. */
  linkedScreenshots: RedLogEvent[]
  tz: TzMode
  projectTz: string | null
  operatorLabel: (id: string) => string
  onAmend: (markerId: string, changes: Partial<MarkerValues>) => void
  onSelect: (e: RedLogEvent) => void
  /** Fetch a marker that is outside the loaded page and select it. */
  onResolveOriginal: (markerId: string) => void
}

const d = (e: RedLogEvent): Record<string, unknown> => (e.data ?? {}) as Record<string, unknown>

export function MarkerDetail(props: MarkerDetailProps): JSX.Element {
  const { event, fold } = props
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<MarkerValues>({ title: '', severity: 'info', notes: '' })
  const titleRef = useRef<HTMLInputElement>(null)

  const data = d(event)
  const effective: MarkerValues = fold?.effective ?? {
    title: typeof data.title === 'string' ? data.title : '',
    severity: typeof data.severity === 'string' ? data.severity : 'info',
    notes: typeof data.notes === 'string' ? data.notes : ''
  }

  // A new selection is a different marker; never carry a half-typed correction
  // across to one.
  useEffect(() => { setEditing(false) }, [event.id])
  useEffect(() => { if (editing) titleRef.current?.focus() }, [editing])

  if (isMarkerAmendment(event)) return <AmendmentView {...props} />

  const startEdit = (): void => {
    // Seeded from what is on screen, not from what was first written —
    // otherwise opening the editor silently reverts two earlier corrections.
    setDraft({ ...effective })
    setEditing(true)
  }

  const commit = (): void => {
    const changes = diffAgainst(effective, draft)
    // An unchanged draft writes nothing. A vacuous amendment would still be a
    // permanent signed row saying an operator changed something.
    if (Object.keys(changes).length === 0) { setEditing(false); return }
    props.onAmend(event.id, changes)
    setEditing(false)
  }

  // Enter commits from the title, ⌘↩ / Ctrl↩ from anywhere, Esc cancels. Both
  // keys stop here: the Timeline's window handler reads plain Enter as
  // "toggle the Inspector" and Esc as "close it", and only exempts real text
  // inputs — so a severity chip with focus would otherwise close the panel
  // mid-edit.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation()
      setEditing(false)
      return
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault(); e.stopPropagation()
      commit()
    }
  }

  return (
    <div className="mt-2 space-y-3">
      {editing ? (
        <div className="space-y-2" onKeyDown={onKeyDown} data-testid="marker-amend-form">
          <input
            ref={titleRef}
            data-testid="marker-amend-title"
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); e.stopPropagation(); commit() } }}
            className="w-full px-2 py-1.5 bg-redlog-bg border border-redlog-border rounded text-sm text-redlog-text focus:outline-none focus:border-redlog-accent"
            aria-label={t('marker.field.title')}
          />
          <div className="flex items-center gap-1.5">
            {MARKER_SEVERITIES.map((s) => (
              <button
                key={s}
                type="button"
                data-testid={`marker-amend-severity-${s}`}
                aria-pressed={draft.severity === s}
                onClick={() => setDraft({ ...draft, severity: s })}
                className={`px-2 py-1 rounded text-xs border ${
                  draft.severity === s
                    ? 'bg-redlog-elevated border-redlog-text-dim text-redlog-text'
                    : 'bg-transparent border-redlog-border text-redlog-text-dim hover:text-redlog-text'
                }`}
              >
                {t(`marker.severity.${s}`)}
              </button>
            ))}
          </div>
          <textarea
            data-testid="marker-amend-notes"
            value={draft.notes}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            rows={3}
            className="w-full px-2 py-1.5 bg-redlog-bg border border-redlog-border rounded text-xs text-redlog-text font-mono focus:outline-none focus:border-redlog-accent"
            aria-label={t('marker.field.notes')}
          />
          <p className="text-xs text-redlog-text-dim">{t('marker.amendKeysHint')}</p>
          <div className="flex items-center gap-2">
            <Button level="primary" data-testid="marker-amend-commit" onClick={commit}>
              {t('marker.amendSave')}
            </Button>
            <Button level="quiet" data-testid="marker-amend-cancel" onClick={() => setEditing(false)}>
              {t('marker.amendCancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-1.5">
          <p className="text-sm text-redlog-text">{effective.title}</p>
          <p className="text-xs text-redlog-text-dim">
            {t(`marker.severity.${effective.severity}`)}
            {typeof data.category === 'string' && ` · ${t(`marker.category.${data.category}`)}`}
          </p>
          {effective.notes && (
            <p className="text-xs text-redlog-text-dim font-mono whitespace-pre-wrap leading-relaxed">{effective.notes}</p>
          )}
          <Button level="quiet" data-testid="marker-amend" onClick={startEdit} className="!h-7 !px-2 !text-xs">
            {t('marker.amend')}
          </Button>
        </div>
      )}

      <ImmutableBlock {...props} />

      {/* §22 — a noun does not appear before its data exists. Most markers are
          never amended, and the Inspector is an 18vh panel. */}
      {fold && fold.amendCount > 0 && (
        <div data-testid="marker-history">
          <p className="text-xs font-semibold text-redlog-text-faint uppercase tracking-wider mb-1">
            {t('marker.amendHistory', { count: fold.amendCount })}
          </p>
          <ul className="space-y-1">
            {fold.history.map((h) => (
              <li key={h.event.id} data-testid="marker-history-row" className="flex items-baseline gap-2 text-xs">
                <span className="text-redlog-text-faint font-mono tabular-nums shrink-0">
                  {formatTs(h.event.timestamp, props.tz, props.projectTz, 'timeSec')}
                </span>
                <span className="text-redlog-text-dim shrink-0 max-w-[100px] truncate" title={h.event.operatorId}>
                  {props.operatorLabel(h.event.operatorId)}
                </span>
                <span className="text-redlog-text-dim truncate" title={changeText(h.changes, t)}>
                  {changeText(h.changes, t)}
                </span>
                <button
                  type="button"
                  onClick={() => props.onSelect(h.event)}
                  className="ml-auto shrink-0 text-redlog-text-dim hover:text-redlog-text underline decoration-dotted"
                >
                  {t('marker.amendView')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

type Translate = (k: string, v?: Record<string, string | number>) => string

/** One line per amendment. A structurally valid row that applies nothing still
 *  says so rather than rendering blank — the count must never describe more
 *  rows than the operator can see. */
function changeText(changes: MarkerFold['history'][number]['changes'], t: Translate): string {
  if (changes.length === 0) return t('marker.amendNoApplicable')
  return changes.map((c) => (
    c.field === 'notes'
      ? t('marker.amendDiffNotes')
      : t('marker.amendDiff', { field: t(`marker.field.${c.field}`), from: String(c.from), to: String(c.to) })
  )).join(' · ')
}

/** What an amendment cannot touch, and one line each on why. Rows appear only
 *  when the field is actually present — a marker has no `url`, so inventing an
 *  empty row for one would describe a field that does not exist. */
function ImmutableBlock({ event, linkedScreenshots, tz, projectTz, operatorLabel }: MarkerDetailProps): JSX.Element {
  const { t } = useI18n()
  const data = d(event)
  const at = data.atTimestamp
  const causes = Array.isArray(data._causes) ? (data._causes as unknown[]).filter((c) => typeof c === 'string') : []

  const rows: Array<{ label: string; why: string; value: string }> = [
    { label: t('marker.readonly.recordedAt'), why: t('marker.readonly.recordedAtWhy'), value: formatTs(event.timestamp, tz, projectTz, 'full') }
  ]
  if (typeof at === 'number' && at > 0) {
    rows.push({ label: t('marker.readonly.atTimestamp'), why: t('marker.readonly.atTimestampWhy'), value: formatTs(at, tz, projectTz, 'full') })
  }
  if (typeof data.category === 'string') {
    rows.push({ label: t('marker.readonly.category'), why: t('marker.readonly.categoryWhy'), value: t(`marker.category.${data.category}`) })
  }
  rows.push({ label: t('marker.readonly.operator'), why: t('marker.readonly.operatorWhy'), value: operatorLabel(event.operatorId) })
  if (linkedScreenshots.length > 0) {
    rows.push({ label: t('marker.readonly.screenshot'), why: t('marker.readonly.screenshotWhy'), value: String(linkedScreenshots.length) })
  }
  if (causes.length > 0) {
    rows.push({ label: t('marker.readonly.sourceEvent'), why: t('marker.readonly.sourceEventWhy'), value: String(causes[0]) })
  }
  if (event.hash) {
    rows.push({ label: t('marker.readonly.hash'), why: t('marker.readonly.hashWhy'), value: `${event.hash.slice(0, 12)}…` })
  }

  return (
    <div>
      <p className="text-xs font-semibold text-redlog-text-faint uppercase tracking-wider mb-1">
        {t('marker.readonly.heading')}
      </p>
      <ul className="space-y-0.5">
        {rows.map((r) => (
          <li key={r.label} className="flex items-baseline gap-2 text-xs">
            <span className="text-redlog-text-dim shrink-0 w-20">{r.label}</span>
            <span className="text-redlog-text-dim font-mono tabular-nums truncate" title={`${r.value}\n${r.why}`}>{r.value}</span>
            <span className="text-redlog-text-faint truncate ml-auto" title={r.why}>{r.why}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Selected an amendment row directly — from its own dot, a search hit or the
 *  history list. It reads as what it is, and offers the way back to the finding
 *  it corrects even when that row is outside the loaded page. */
function AmendmentView({ event, onResolveOriginal }: MarkerDetailProps): JSX.Element {
  const { t } = useI18n()
  const data = d(event)
  const markerId = String(data.markerId ?? '')
  const fields = amendedFields(event)

  return (
    <div className="mt-2 space-y-2" data-testid="marker-amendment-view">
      <p className="text-sm text-redlog-text">
        {t('marker.amendmentRow', {
          title: markerId,
          fields: fields.map((f) => t(`marker.field.${f}`)).join('、')
        })}
      </p>
      <ul className="space-y-0.5">
        {AMENDABLE_FIELDS.filter((f) => data[f] !== undefined).map((f) => (
          <li key={f} className="flex items-baseline gap-2 text-xs">
            <span className="text-redlog-text-dim shrink-0 w-20">{t(`marker.field.${f}`)}</span>
            <span className="text-redlog-text font-mono truncate" title={String(data[f])}>
              {f === 'severity' ? t(`marker.severity.${String(data[f])}`) : String(data[f])}
            </span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        data-testid="marker-amend-resolve-original"
        onClick={() => onResolveOriginal(markerId)}
        className="text-xs text-redlog-text-dim hover:text-redlog-text underline decoration-dotted"
      >
        {t('timeline.detail.causeUnpaged')}
      </button>
    </div>
  )
}
