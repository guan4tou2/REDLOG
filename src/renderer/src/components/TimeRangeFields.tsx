import { toLocalInputValue, fromLocalInputValue, timeRangeError } from '../lib/timeRangeInput'
import { useDisplayZone } from '../lib/time'
import { useI18n } from '../i18n'
import type { TimeRange } from '../lib/FilterContext'

/** The from/to inputs of the shared time filter. The filter bar and the
 *  Timeline toolbar both render this, so they read and write one range with
 *  one set of rules. The inputs are wall-clock in whichever zone the rest of
 *  the UI is displaying, so they agree with the timestamps beside them. */
export function TimeRangeFields({ timeRange, setTimeRange, testIdPrefix = 'filter-time' }: {
  timeRange: TimeRange | null
  setTimeRange: (range: TimeRange | null) => void
  testIdPrefix?: string
}): JSX.Element {
  const { t } = useI18n()
  // Named beside the inputs, because a wall-clock field with no zone is
  // ambiguous exactly where it matters.
  const zoneLabel = useDisplayZone() === 'utc' ? 'UTC' : t('filter.localTime')
  return (
    <>
      {/* "Events on the 14th between 09:00 and 11:00" could not be asked
          for at all. */}
      <div className="flex flex-wrap min-w-0 items-end gap-2 pt-1">
        <label className="flex min-w-0 max-w-full flex-col gap-0.5">
          <span className="text-xs text-redlog-text-faint">{t('filter.from')}</span>
          <input
            type="datetime-local"
            data-testid={`${testIdPrefix}-since`}
            aria-label={t('filter.from')}
            value={toLocalInputValue(timeRange?.since)}
            onChange={(e) => {
              const since = fromLocalInputValue(e.target.value)
              const next = { ...(timeRange ?? {}), since }
              setTimeRange(next.since === undefined && next.before === undefined ? null : next)
            }}
            className="min-w-0 max-w-full bg-redlog-bg border border-redlog-border rounded px-1.5 py-0.5 text-xs text-redlog-text"
          />
        </label>
        <label className="flex min-w-0 max-w-full flex-col gap-0.5">
          <span className="text-xs text-redlog-text-faint">{t('filter.to')}</span>
          <input
            type="datetime-local"
            data-testid={`${testIdPrefix}-before`}
            aria-label={t('filter.to')}
            value={toLocalInputValue(timeRange?.before)}
            onChange={(e) => {
              const before = fromLocalInputValue(e.target.value)
              const next = { ...(timeRange ?? {}), before }
              setTimeRange(next.since === undefined && next.before === undefined ? null : next)
            }}
            className="min-w-0 max-w-full bg-redlog-bg border border-redlog-border rounded px-1.5 py-0.5 text-xs text-redlog-text"
          />
        </label>
        <span className="text-xs text-redlog-text-faint pb-1">{zoneLabel}</span>
      </div>
      {/* An end before its start is the one way to ask for nothing at all.
          Saying so beats an empty view that reads as an empty project. */}
      {timeRange && timeRangeError(timeRange) && (
        <p data-testid={`${testIdPrefix}-invalid`} role="status" className="text-xs text-amber-400">
          {t('filter.timeRangeInvalid')}
        </p>
      )}
    </>
  )
}
