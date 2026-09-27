// Pieces of the Timeline that only render what they are given (UI/UX audit
// F13). Timeline.tsx had grown to ~3000 lines in one function; these moved
// out first because they hold no state of their own, so the move cannot change
// behaviour — the panel still owns every value they show.

import type { RefObject } from 'react'
import type { FullVerifyResult } from '../../lib/verifyResultCache'

type Translate = (key: string, vars?: Record<string, string | number>) => string

/** Sticks above the header so a broken chain cannot be missed. Dismiss hides
 *  it for this mount only; the verify cache still holds the result. */
export function BrokenChainBanner({ result, dismissed, onDismiss, t }: {
  result: FullVerifyResult | null
  dismissed: boolean
  onDismiss: () => void
  t: Translate
}): JSX.Element | null {
  if (!result || !result.brokenAtEventId || dismissed) return null
  return (
    <div
      data-testid="timeline-broken-chain-banner"
      role="alert"
      className="flex items-center gap-2 px-4 py-1.5 border-b border-red-800 bg-red-950/50 text-xs shrink-0"
    >
      <span className="text-red-300 font-mono">
        {t('timeline.brokenChain.banner', {
          brokenAtId: result.brokenAtEventId.slice(0, 8),
          walked: String(result.walked ?? 0)
        })}
      </span>
      <button
        onClick={onDismiss}
        className="ml-auto text-xs text-red-300 hover:text-red-100 px-1.5 py-0.5 rounded bg-red-900/40 hover:bg-red-900/60 transition-colors"
      >
        {t('timeline.brokenChain.dismiss')}
      </button>
    </div>
  )
}

export interface FocusMeta { loading: boolean; truncated: boolean; unavailable: number; failed: boolean; excluded?: number }

/** Top-right badge while focus mode is on: how many events the chain holds,
 *  and what it could not include. */
export function FocusChainBadge({ size, active, meta, onExit, t }: {
  size: number
  active: boolean
  meta: FocusMeta
  onExit: () => void
  t: Translate
}): JSX.Element | null {
  if (!active && !meta.loading && !meta.failed) return null
  const settled = !meta.loading && !meta.failed
  return (
    <div
      data-testid="timeline-focus-badge"
      className="absolute z-40 flex items-center gap-2 px-2 py-1 rounded-md border border-cyan-500/50 bg-redlog-bg/95 text-xs font-mono shadow-lg"
      style={{ top: 6, right: 8 }}
    >
      <span className="text-cyan-300">
        {meta.loading
          ? t('timeline.focusChain.loading')
          : meta.failed
            ? t('timeline.focusChain.failed')
            : t('timeline.focusChain.badge', { count: size })}
        {settled && meta.unavailable > 0 ? ` · ${t('timeline.focusChain.unavailable', { count: meta.unavailable })}` : ''}
        {settled && meta.truncated ? ` · ${t('timeline.focusChain.truncated')}` : ''}
        {settled && (meta.excluded ?? 0) > 0 ? ` · ${t('timeline.focusChain.outsideFilter', { count: meta.excluded ?? 0 })}` : ''}
      </span>
      <button
        onClick={onExit}
        className="text-redlog-text-dim hover:text-redlog-text leading-none w-4 h-4 flex items-center justify-center rounded hover:bg-white/10"
        title={t('timeline.focusChain.exit')}
        aria-label={t('timeline.focusChain.exit')}
      >×</button>
    </div>
  )
}

/** The `/` box. It dims events that do not match — it does not remove them,
 *  which is what the filter bar above does — so it is named a highlight. */
export function HighlightInput({ value, onChange, inputRef, t }: {
  value: string
  onChange: (v: string) => void
  inputRef: RefObject<HTMLInputElement | null>
  t: Translate
}): JSX.Element {
  return (
    <div className="relative flex items-center ml-2">
      <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-xs text-redlog-text-faint pointer-events-none font-mono">/</span>
      <input
        ref={inputRef}
        data-testid="timeline-search-input"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            if (value) { onChange(''); e.preventDefault() }
            else inputRef.current?.blur()
          }
        }}
        placeholder={t('timeline.search.placeholder')}
        title={t('timeline.search.hint')}
        aria-label={t('timeline.search.label')}
        className="pl-5 pr-6 py-0.5 h-6 w-[220px] text-xs font-mono bg-redlog-surface/70 border border-dashed border-redlog-border rounded text-redlog-text placeholder:text-redlog-text-faint focus:outline-none focus:border-redlog-accent/60"
      />
      {value && (
        <button
          onClick={() => onChange('')}
          title={t('timeline.search.clear')}
          aria-label={t('timeline.search.clear')}
          className="absolute right-1 top-1/2 -translate-y-1/2 text-redlog-text-dim hover:text-redlog-text leading-none w-4 h-4 flex items-center justify-center rounded hover:bg-white/10"
        >×</button>
      )}
    </div>
  )
}
