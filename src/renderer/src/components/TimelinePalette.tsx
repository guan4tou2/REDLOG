import { useEffect, useRef, useState, useMemo } from 'react'
import { computePaletteResults, type PaletteItem } from '../lib/timelineFilters'
import type { RedLogEvent } from '../../../core/db/event-types'

interface TimelinePaletteProps {
  open: boolean
  onClose: () => void
  events: readonly RedLogEvent[]
  operatorNames: Record<string, string>
  titleOf: (e: RedLogEvent) => string
  onActivate: (item: PaletteItem) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}

export function TimelinePalette({
  open, onClose, events, operatorNames, titleOf, onActivate, t
}: TimelinePaletteProps): JSX.Element | null {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const results = useMemo(
    () => computePaletteResults(events, operatorNames, query, titleOf),
    [events, operatorNames, query, titleOf]
  )

  useEffect(() => {
    if (index >= results.length) setIndex(Math.max(0, results.length - 1))
  }, [results, index])

  useEffect(() => {
    if (open) {
      setQuery('')
      setIndex(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  if (!open) return null

  const activate = (item: PaletteItem): void => {
    onActivate(item)
    onClose()
  }

  return (
    <div
      data-testid="timeline-palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-[560px] max-w-[92vw] rounded-lg border border-redlog-border bg-redlog-bg shadow-2xl overflow-hidden">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setIndex(0) }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { onClose(); return }
            if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(results.length - 1, i + 1)); return }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); return }
            if (e.key === 'Enter') {
              e.preventDefault()
              const item = results[index]
              if (item) activate(item)
            }
          }}
          placeholder={t('timeline.palette.placeholder')}
          className="w-full px-3 py-2 bg-redlog-bg text-sm font-mono text-redlog-text placeholder:text-redlog-text-dim border-b border-redlog-border focus:outline-none"
        />
        <div className="max-h-[360px] overflow-y-auto">
          {results.length === 0 ? (
            <div className="px-3 py-4 text-xs text-redlog-text-dim font-mono text-center">{t('timeline.palette.noResults')}</div>
          ) : results.map((item, i) => {
            const groupKey = item.kind === 'event' ? 'timeline.palette.groupEvent'
              : item.kind === 'marker' ? 'timeline.palette.groupMarker'
              : item.kind === 'operator' ? 'timeline.palette.groupOperator'
              : 'timeline.palette.groupHost'
            const isSel = i === index
            return (
              <button
                key={'event' in item ? item.event.id : `${item.kind}-${item.value}`}
                onMouseEnter={() => setIndex(i)}
                onClick={() => activate(item)}
                className={`w-full text-left px-3 py-1.5 flex items-center gap-2 ${isSel ? 'bg-white/10' : 'hover:bg-white/5'}`}
              >
                <span className="text-xs font-mono uppercase tracking-wider text-redlog-text-dim w-14 shrink-0">
                  {t(groupKey)}
                </span>
                <span title={item.label} className="text-xs font-mono text-redlog-text truncate flex-1">{item.label}</span>
                <span className="text-xs font-mono text-redlog-text-faint shrink-0">{item.sub}</span>
              </button>
            )
          })}
        </div>
        <div className="px-3 py-1.5 border-t border-redlog-border text-xs font-mono text-redlog-text-dim text-center">
          {t('timeline.palette.footer')}
        </div>
      </div>
    </div>
  )
}
