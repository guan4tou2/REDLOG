import { useState, useRef, useEffect } from 'react'
import { Filter, X, ChevronDown } from 'lucide-react'
import { toLocalInputValue, fromLocalInputValue, timeRangeError } from '../lib/timeRangeInput'
import { useSharedFilter, conditionLabels } from '../lib/FilterContext'
import { useI18n } from '../i18n'
import { useDisplayZone } from '../lib/time'
import { agentTypeLabel } from '../lib/timelineDomain'

export function FilterBar(): JSX.Element | null {
  const { filter, setTargetId, setAgentType, setTimeRange, setInScopeOnly, setHidePersonal, setTier, clearAll,
    activeCount, knownTargets, knownAgentTypes, scopeTargets, scopeExcludeTargets, personalDomains,
    listsStatus, scopeStatus, retryLists } = useSharedFilter()
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  // Named beside the inputs, because a wall-clock field with no zone is
  // ambiguous exactly where it matters.
  const zoneLabel = useDisplayZone() === 'utc' ? 'UTC' : t('filter.localTime')
  const labels = conditionLabels(filter, t)
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setExpanded(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  return (
    <div ref={barRef} className="shrink-0 border-b border-redlog-border bg-redlog-bg/50">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <button
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls="filter-bar-panel"
          className="flex items-center gap-1 text-redlog-text-dim hover:text-redlog-text transition-colors"
          title={t('filter.title')}
        >
          <Filter size={12} strokeWidth={1.5} />
          <span>{t('filter.title')}</span>
          {activeCount > 0 && (
            <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-redlog-elevated text-redlog-text text-xs font-medium tabular-nums">
              {activeCount}
            </span>
          )}
          <ChevronDown size={10} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>

        {/* Active filter chips — always visible */}
        {filter.targetId && (
          <Chip label={labels.target ?? ''} onClear={() => setTargetId(null)} />
        )}
        {filter.agentType && (
          <Chip label={labels.type ?? ''} title={filter.agentType} onClear={() => setAgentType(null)} />
        )}
        {filter.timeRange && (
          <Chip
            label={labels.time ?? ''}
            onClear={() => setTimeRange(null)}
          />
        )}
        {(scopeTargets.length > 0 || scopeExcludeTargets.length > 0) && (
          <button
            onClick={() => setInScopeOnly(!filter.inScopeOnly)}
            aria-pressed={filter.inScopeOnly}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border transition-colors ${
              filter.inScopeOnly
                ? 'border-red-500/40 bg-red-500/10 text-red-400'
                : 'border-redlog-border text-redlog-text-dim hover:text-redlog-text hover:border-redlog-accent/30'
            }`}
            title={t('filter.inScopeHint')}
          >
            {t('filter.inScopeOnly')}
          </button>
        )}
        {/* Spec 038: the auditor's "chained evidence only", as a condition
            every event view applies, not a Timeline display switch. Always
            shown: every project has the chained tier. */}
        <button
          onClick={() => setTier(filter.tier === 'chained' ? 'all' : 'chained')}
          aria-pressed={filter.tier === 'chained'}
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border transition-colors ${
            filter.tier === 'chained'
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
              : 'border-redlog-border text-redlog-text-dim hover:text-redlog-text hover:border-redlog-accent/30'
          }`}
          title={t('filter.chainedOnlyHint')}
        >
          {t('filter.chainedOnly')}
        </button>
        {personalDomains.length > 0 && (
          <button
            onClick={() => setHidePersonal(!filter.hidePersonal)}
            aria-pressed={filter.hidePersonal}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border transition-colors ${
              filter.hidePersonal
                ? 'border-amber-500/35 bg-amber-500/10 text-amber-300'
                : 'border-redlog-border text-redlog-text-dim hover:text-redlog-text'
            }`}
            title={filter.hidePersonal ? t('filter.personalHiddenHint') : t('filter.personalShownHint')}
          >
            {filter.hidePersonal ? t('filter.personalHidden') : t('filter.personalShown')}
          </button>
        )}
        {activeCount > 1 && (
          <button
            onClick={clearAll}
            className="text-redlog-text-faint hover:text-red-400 text-xs underline ml-1"
          >{t('filter.clearAll')}</button>
        )}
      </div>

      {expanded && (
        <div id="filter-bar-panel" className="px-3 pb-2 flex flex-wrap gap-3">
          {/* An empty menu and a menu that failed to load look identical, and
              the difference matters: one says this project has no targets, the
              other says we do not know. Whatever loaded before is kept and
              labelled stale rather than blanked. */}
          {(listsStatus === 'error' || scopeStatus === 'error') && (
            <div
              data-testid="filter-lists-error"
              role="status"
              className="w-full rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 flex items-center gap-3"
            >
              <span className="flex-1">{t('filter.listsFailed')}</span>
              <button
                onClick={retryLists}
                className="px-2 py-0.5 rounded border border-amber-500/40 hover:bg-amber-500/20"
              >{t('filter.listsRetry')}</button>
            </div>
          )}
          {/* Target selector */}
          <FilterSelect
            label={t('filter.target')}
            value={filter.targetId}
            onChange={setTargetId}
            options={knownTargets.map((tg) => ({
              value: tg.target,
              label: `${tg.target} (${tg.eventCount})`
            }))}
            placeholder={t('filter.allTargets')}
          />

          {/* Agent type selector */}
          <FilterSelect
            label={t('filter.type')}
            value={filter.agentType}
            onChange={setAgentType}
            options={knownAgentTypes.map((at) => ({ value: at, label: agentTypeLabel(at, t), title: at }))}
            placeholder={t('filter.allTypes')}
          />

          {/* Time range presets */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-redlog-text-faint uppercase tracking-wider">{t('filter.time')}</span>
            <div className="flex gap-1">
              {/* A preset takes a SNAPSHOT of the last N hours: the condition
                  stops where it was clicked, so a result set does not slide
                  while the operator reads it. That was already the behaviour;
                  what was missing is saying so — the button said "last 1h"
                  and twenty minutes later meant "since 15:03". The chip now
                  prints the absolute window, and the title says it is fixed. */}
              {[
                { label: t('filter.last1h'), ms: 3600_000 },
                { label: t('filter.last6h'), ms: 21600_000 },
                { label: t('filter.last24h'), ms: 86400_000 },
              ].map((preset) => {
                const active = filter.timeRange?.since
                  && Date.now() - filter.timeRange.since < preset.ms * 1.1
                  && Date.now() - filter.timeRange.since > preset.ms * 0.5
                return (
                  <button
                    key={preset.ms}
                    title={t('filter.presetIsSnapshot')}
                    onClick={() => setTimeRange({ since: Date.now() - preset.ms })}
                    className={`px-2 py-0.5 rounded text-xs border transition-colors ${
                      active
                        ? 'border-red-500/40 bg-red-500/10 text-red-400'
                        : 'border-redlog-border text-redlog-text-dim hover:text-redlog-text hover:border-redlog-accent/30'
                    }`}
                  >{preset.label}</button>
                )
              })}
              {filter.timeRange && (
                <button
                  onClick={() => setTimeRange(null)}
                  className="px-2 py-0.5 rounded text-xs border border-redlog-border text-redlog-text-faint hover:text-redlog-text"
                >{t('filter.allTime')}</button>
              )}
            </div>
            {/* "Events on the 14th between 09:00 and 11:00" could not be asked
                for at all. The inputs are wall-clock in whichever zone the
                rest of the UI is displaying, so they agree with the
                timestamps beside them. */}
            <div className="flex items-end gap-2 pt-1">
              <label className="flex flex-col gap-0.5">
                <span className="text-xs text-redlog-text-faint">{t('filter.from')}</span>
                <input
                  type="datetime-local"
                  data-testid="filter-time-since"
                  aria-label={t('filter.from')}
                  value={toLocalInputValue(filter.timeRange?.since)}
                  onChange={(e) => {
                    const since = fromLocalInputValue(e.target.value)
                    const next = { ...(filter.timeRange ?? {}), since }
                    setTimeRange(next.since === undefined && next.before === undefined ? null : next)
                  }}
                  className="bg-redlog-bg border border-redlog-border rounded px-1.5 py-0.5 text-xs text-redlog-text"
                />
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-xs text-redlog-text-faint">{t('filter.to')}</span>
                <input
                  type="datetime-local"
                  data-testid="filter-time-before"
                  aria-label={t('filter.to')}
                  value={toLocalInputValue(filter.timeRange?.before)}
                  onChange={(e) => {
                    const before = fromLocalInputValue(e.target.value)
                    const next = { ...(filter.timeRange ?? {}), before }
                    setTimeRange(next.since === undefined && next.before === undefined ? null : next)
                  }}
                  className="bg-redlog-bg border border-redlog-border rounded px-1.5 py-0.5 text-xs text-redlog-text"
                />
              </label>
              <span className="text-xs text-redlog-text-faint pb-1">{zoneLabel}</span>
            </div>
            {/* An end before its start is the one way to ask for nothing at
                all. Saying so beats an empty view that reads as an empty
                project. */}
            {filter.timeRange && timeRangeError(filter.timeRange) && (
              <p data-testid="filter-time-invalid" role="status" className="text-xs text-amber-400">
                {t('filter.timeRangeInvalid')}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Chip({ label, title, onClear }: { label: string; title?: string; onClear: () => void }): JSX.Element {
  const { t } = useI18n()
  return (
    <span title={title} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-redlog-elevated text-xs text-redlog-text-dim border border-redlog-border">
      {label}
      <button
        onClick={onClear}
        className="hover:text-red-400 transition-colors"
        /* Names the condition it removes, and in the operator's language.
           Every chip used to announce the same untranslated "Clear". */
        aria-label={t('filter.clearCondition', { condition: label })}
        title={t('filter.clearCondition', { condition: label })}
      >
        <X size={10} />
      </button>
    </span>
  )
}

function FilterSelect({ label, value, onChange, options, placeholder }: {
  label: string
  value: string | null
  onChange: (v: string | null) => void
  options: Array<{ value: string; label: string; title?: string }>
  placeholder: string
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-redlog-text-faint uppercase tracking-wider">{label}</span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="bg-redlog-elevated border border-redlog-border rounded px-2 py-0.5 text-xs text-redlog-text font-mono focus:outline-none focus:border-red-500/50"
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value} title={o.title}>{o.label}</option>
        ))}
      </select>
    </div>
  )
}
