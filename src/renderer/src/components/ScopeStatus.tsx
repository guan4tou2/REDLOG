import { useState, useEffect } from 'react'
import { useI18n } from '../i18n'
import { LoadingSpinner } from './Feedback'
import { toast } from './Toast'
import { Ban } from 'lucide-react'
import { formatTime } from '../lib/time'
import { useListKeyboard } from '../lib/useListKeyboard'

export function ScopeStatus({ onOpenInTimeline }: { onOpenInTimeline?: (ts: number) => void } = {}): JSX.Element {
  const [violations, setViolations] = useState<Array<{ target: string; command: string; timestamp: number }>>([])
  const [configured, setConfigured] = useState(false)
  const [chainLen, setChainLen] = useState(0)
  const [loading, setLoading] = useState(true)
  const { t } = useI18n()

  // §9's list contract, same as Findings/Loot/Search. The violation list is
  // the one an operator reaches for under time pressure — "which rule did this
  // hit, and where is it on the timeline" — so it should not be the one list
  // that needs a mouse.
  const shownViolations = violations.slice(0, 10)
  const listNav = useListKeyboard({
    count: shownViolations.length,
    onActivate: (i) => { const v = shownViolations[i]; if (v) onOpenInTimeline?.(v.timestamp) },
    onJumpToTimeline: (i) => { const v = shownViolations[i]; if (v) onOpenInTimeline?.(v.timestamp) }
  })

  useEffect(() => {
    Promise.all([
      window.redlog.scope.isConfigured().then(setConfigured),
      window.redlog.scope.getViolations().then(setViolations),
      window.redlog.chain.length().then(setChainLen)
    ]).then(() => setLoading(false))

    const unsub = window.redlog.events.onNew((event) => {
      if (event.agentType === 'system' && (event.data as Record<string, unknown>)?.subtype === 'scope_violation') {
        window.redlog.scope.getViolations().then(setViolations)
      }
      window.redlog.chain.length().then(setChainLen)
    })
    return unsub
  }, [])

  if (loading) {
    return (
      <LoadingSpinner />
    )
  }

  return (
    <div className="p-4 space-y-4 overflow-auto h-full">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">{t('scope.title')}</h2>
        {violations.length > 0 && (
          <button
            onClick={async () => {
              const p = await (window.redlog.data as { exportViolations?: () => Promise<string | null> }).exportViolations?.()
              if (p) toast(t('toast.exportedTo', { path: p }), 'success')
              else toast(t('toast.exportFailed'), { type: 'error', why: t('toast.exportFailedWhy') })
            }}
            className="px-2.5 py-1 text-xs bg-redlog-elevated text-redlog-text-dim rounded hover:bg-redlog-elevated-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40"
            title={t('scope.exportHint')}
          >{t('scope.export')}</button>
        )}
      </div>

      <div className="bg-redlog-surface border border-redlog-border rounded-lg p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-redlog-text text-sm font-medium">{t('scope.monitor')}</span>
          {configured ? (
            <span className="text-green-400 text-xs bg-green-400/10 px-2 py-0.5 rounded">{t('scope.active')}</span>
          ) : (
            <span className="text-redlog-text-dim text-xs bg-redlog-elevated px-2 py-0.5 rounded">{t('scope.notSet')}</span>
          )}
        </div>
        {configured && violations.length === 0 && (
          <p className="text-green-400 text-xs">{t('scope.allInScope')}</p>
        )}
        {violations.length > 0 && (
          <div className="text-red-400 text-sm">
            {t('scope.violations', { count: violations.length })}
          </div>
        )}
        {!configured && (
          <div className="flex flex-col items-center py-6 gap-2">
            <div className="w-12 h-12 rounded-full bg-redlog-elevated border border-redlog-border flex items-center justify-center">
              <Ban size={20} strokeWidth={1.5} aria-hidden className="text-redlog-text-faint" />
            </div>
            <p className="text-redlog-text-dim text-xs">
              {t('scope.hint')}
            </p>
          </div>
        )}
      </div>

      <div className="bg-redlog-surface border border-redlog-border rounded-lg p-3">
        <div className="flex items-center justify-between">
          <span className="text-redlog-text text-sm font-medium">{t('scope.evidenceLog')}</span>
          <span className="text-redlog-text-dim text-xs">{t('scope.entries', { count: chainLen })}</span>
        </div>
      </div>

      {violations.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-sm text-redlog-text-dim">{t('scope.recentViolations')}</h3>
          <div
            className="space-y-1"
            {...listNav.containerProps}
            aria-label={t('scope.violationsLabel', { count: shownViolations.length })}
          >
          {shownViolations.map((v, i) => {
            const rowProps = listNav.itemProps(i)
            return (
            <button
              key={i}
              {...rowProps}
              ref={(el) => rowProps.ref(el)}
              onClick={() => { rowProps.onClick(); onOpenInTimeline?.(v.timestamp) }}
              disabled={!onOpenInTimeline}
              className="w-full text-left bg-red-900/20 border border-red-800/30 rounded p-2 hover:bg-red-900/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 disabled:cursor-default disabled:hover:bg-red-900/20 transition-colors"
              title={onOpenInTimeline ? t('scope.openInTimeline') : undefined}
            >
              <div className="text-red-300 text-xs font-mono">{v.target}</div>
              <div title={v.command} className="text-redlog-text-dim text-xs truncate">{v.command}</div>
              <div className="text-redlog-text-faint text-xs">{formatTime(v.timestamp, { seconds: true })}</div>
            </button>
            )
          })}
          </div>
        </div>
      )}
    </div>
  )
}
