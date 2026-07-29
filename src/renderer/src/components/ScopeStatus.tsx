import { useState, useEffect } from 'react'
import { useI18n } from '../i18n'
import { HudPanel } from './Hud'

export function ScopeStatus(): JSX.Element {
  const [violations, setViolations] = useState<Array<{ target: string; command: string; timestamp: number }>>([])
  const [configured, setConfigured] = useState(false)
  const [chainLen, setChainLen] = useState(0)
  const [loading, setLoading] = useState(true)
  const { t } = useI18n()

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
      <div className="flex items-center justify-center h-full">
        <div className="w-6 h-6 border-2 border-zinc-700 border-t-red-500 rounded-full animate-spin-slow" />
      </div>
    )
  }

  return (
    <div className="p-4 space-y-4 overflow-auto h-full">
      <h2 className="text-lg font-semibold text-white">{t('scope.title')}</h2>

      <HudPanel tone={violations.length > 0 ? 'red' : configured ? 'green' : 'neutral'}><div className="p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-zinc-300 text-sm font-medium">{t('scope.monitor')}</span>
          {configured ? (
            <span className="text-green-400 text-xs bg-green-400/10 px-2 py-0.5 rounded">{t('scope.active')}</span>
          ) : (
            <span className="text-zinc-500 text-xs bg-zinc-800 px-2 py-0.5 rounded">{t('scope.notSet')}</span>
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
            <div className="w-12 h-12 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center">
              <span className="text-xl text-zinc-600">⊘</span>
            </div>
            <p className="text-zinc-500 text-xs">
              {t('scope.hint')}
            </p>
          </div>
        )}
      </div></HudPanel>

      <HudPanel tone="cyan"><div className="p-3">
        <div className="flex items-center justify-between">
          <span className="text-zinc-300 text-sm font-medium">{t('scope.evidenceLog')}</span>
          <span className="text-zinc-500 text-xs">{t('scope.entries', { count: chainLen })}</span>
        </div>
      </div></HudPanel>

      {violations.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-sm text-zinc-400">{t('scope.recentViolations')}</h3>
          {violations.slice(0, 10).map((v, i) => (
            <div key={i} className="bg-red-900/20 border border-red-800/30 rounded p-2">
              <div className="text-red-300 text-xs font-mono">{v.target}</div>
              <div className="text-zinc-500 text-xs truncate">{v.command}</div>
              <div className="text-zinc-600 text-xs">{new Date(v.timestamp).toLocaleTimeString()}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
