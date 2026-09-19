import { useState, useRef, useEffect } from 'react'
import { Filter, X, ChevronDown } from 'lucide-react'
import { useSharedFilter } from '../lib/FilterContext'
import { useI18n } from '../i18n'
import { formatTime } from '../lib/time'

export function FilterBar(): JSX.Element | null {
  const { filter, setTargetId, setAgentType, setTimeRange, setInScopeOnly, clearAll,
    activeCount, knownTargets, knownAgentTypes, scopeTargets } = useSharedFilter()
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
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
          <Chip label={`${t('filter.target')}: ${filter.targetId}`} onClear={() => setTargetId(null)} />
        )}
        {filter.agentType && (
          <Chip label={`${t('filter.type')}: ${filter.agentType}`} onClear={() => setAgentType(null)} />
        )}
        {filter.timeRange && (
          <Chip
            label={`${t('filter.time')}: ${formatTimeRange(filter.timeRange, t)}`}
            onClear={() => setTimeRange(null)}
          />
        )}
        {scopeTargets.length > 0 && (
          <button
            onClick={() => setInScopeOnly(!filter.inScopeOnly)}
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
        {activeCount > 1 && (
          <button
            onClick={clearAll}
            className="text-redlog-text-faint hover:text-red-400 text-xs underline ml-1"
          >{t('filter.clearAll')}</button>
        )}
      </div>

      {expanded && (
        <div className="px-3 pb-2 flex flex-wrap gap-3">
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
            options={knownAgentTypes.map((at) => ({ value: at, label: at }))}
            placeholder={t('filter.allTypes')}
          />

          {/* Time range presets */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-redlog-text-faint uppercase tracking-wider">{t('filter.time')}</span>
            <div className="flex gap-1">
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
          </div>
        </div>
      )}
    </div>
  )
}

function Chip({ label, onClear }: { label: string; onClear: () => void }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-redlog-elevated text-xs text-redlog-text-dim border border-redlog-border">
      {label}
      <button onClick={onClear} className="hover:text-red-400 transition-colors" aria-label="Clear">
        <X size={10} />
      </button>
    </span>
  )
}

function FilterSelect({ label, value, onChange, options, placeholder }: {
  label: string
  value: string | null
  onChange: (v: string | null) => void
  options: Array<{ value: string; label: string }>
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
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  )
}

function formatTimeRange(range: { since?: number; before?: number }, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (range.since && !range.before) {
    return t('filter.since', { time: formatTime(range.since, { seconds: false }) })
  }
  if (!range.since && range.before) {
    return t('filter.before', { time: formatTime(range.before, { seconds: false }) })
  }
  if (range.since && range.before) {
    return `${formatTime(range.since, { seconds: false })} – ${formatTime(range.before, { seconds: false })}`
  }
  return ''
}
