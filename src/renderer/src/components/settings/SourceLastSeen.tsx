import { formatDateTime } from '../../lib/time'

/** When this source last delivered something.
 *
 *  #435: the settings row and the dashboard's capture card are the same
 *  question asked in two places — "is this source delivering?" — and the
 *  answer has to be a fact about the record, not a switch position. The same
 *  wording on both screens, from the same snapshot.
 *
 *  A source that is switched off and has never delivered says nothing worth
 *  a line: "nothing received yet" is only news when something was supposed to
 *  be arriving. A source that delivered before and is off now keeps the line,
 *  because that is how the operator sees that it stopped.
 */
export function SourceLastSeen({ source, active, t }: {
  source?: CaptureSourceInfo
  /** Whether the source is supposed to be delivering. When the caller knows
   *  (a switch it just rendered), that wins over the snapshot's own flag —
   *  the snapshot is a picture of a moment and the switch is not. */
  active?: boolean
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element | null {
  if (!source) return null
  const on = active ?? source.enabled ?? true
  if (!on && source.lastEventAt === null) return null
  return (
    <p data-testid={`source-last-${source.id}`} className="text-xs text-redlog-text-faint">
      {source.lastEventAt !== null
        ? t('settings.source.lastReceived', { when: formatDateTime(source.lastEventAt) })
        : t('settings.source.neverReceived')}
    </p>
  )
}
