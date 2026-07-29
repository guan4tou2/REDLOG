import { useState, useEffect } from 'react'
import { useI18n } from '../i18n'

export function LootPanel({ onOpenInTimeline }: { onOpenInTimeline?: (eventId: string, ts: number) => void }): JSX.Element {
  const [lootEvents, setLootEvents] = useState<Array<{
    id: string
    timestamp: number
    targetId: string | null
    source: string | null
    matches: Array<{ type: string; confidence: string; preview: string }>
  }>>([])
  const [lootCount, setLootCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const { t } = useI18n()

  useEffect(() => {
    loadLoot().then(() => setLoading(false))
    window.redlog.loot.getCount().then(setLootCount)
    const unsub = window.redlog.events.onNew((evt) => {
      if (evt.agentType === 'loot') {
        loadLoot()
        window.redlog.loot.getCount().then(setLootCount)
      }
    })
    return unsub
  }, [])

  async function loadLoot(): Promise<void> {
    const events = await window.redlog.events.query({ agentType: 'loot' })
    setLootEvents(
      events.map((e) => ({
        id: e.id,
        timestamp: e.timestamp,
        targetId: e.targetId,
        source: (e.data.source as string) ?? null,
        matches: (e.data.matches as Array<{ type: string; confidence: string; preview: string }>) ?? []
      }))
    )
  }

  const typeColor: Record<string, string> = {
    password_hash: 'text-red-400',
    ntlm_hash: 'text-red-400',
    private_key: 'text-red-400',
    aws_key: 'text-orange-400',
    jwt: 'text-yellow-400',
    generic_api_key: 'text-yellow-400',
    database_url: 'text-red-400',
    shadow_entry: 'text-red-400',
    flag: 'text-green-400',
    base64_creds: 'text-orange-400'
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-6 h-6 border-2 border-zinc-700 border-t-red-500 rounded-full animate-spin-slow" />
      </div>
    )
  }

  return (
    <div className="p-4 space-y-4 overflow-auto h-full">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">{t('loot.title', { count: lootCount })}</h2>
      </div>

      {lootEvents.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <div className="w-16 h-16 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center">
            <span className="text-2xl text-zinc-700">◆</span>
          </div>
          <p className="text-sm text-zinc-500">{t('loot.empty')}</p>
          <p className="text-xs text-zinc-700 text-center max-w-xs">{t('loot.emptyDesc')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {lootEvents.map((le, i) => (
            <div
              key={le.id || i}
              onClick={() => onOpenInTimeline?.(le.id, le.timestamp)}
              className={`bg-zinc-900 border border-zinc-800 rounded-lg p-3 ${onOpenInTimeline ? 'cursor-pointer hover:border-cyan-500/40 hover:bg-zinc-900/60 transition-colors' : ''}`}
              title={onOpenInTimeline ? t('loot.openInTimelineHint') : undefined}
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="text-zinc-500 text-xs">
                  <span className="text-zinc-400 tabular-nums">{new Date(le.timestamp).toLocaleString()}</span>
                  {le.source && (
                    <span> · {t('loot.from')} <span className="text-zinc-300 font-mono">{le.source}</span></span>
                  )}
                  {le.targetId && (
                    <span> · {t('loot.target')} <span className="text-zinc-300 font-mono">{le.targetId}</span></span>
                  )}
                  <span> · {t('loot.items', { count: le.matches.length })}</span>
                </div>
                {onOpenInTimeline && (
                  <span className="text-[10px] text-cyan-400/80 whitespace-nowrap shrink-0">
                    {t('loot.openInTimeline')} →
                  </span>
                )}
              </div>
              {le.matches.map((m, j) => (
                <div key={j} className="border-t border-zinc-800 pt-1 mt-1 first:border-0 first:pt-0 first:mt-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-mono ${typeColor[m.type] || 'text-zinc-400'}`}>
                      {m.type.replace(/_/g, ' ')}
                    </span>
                    <span className={`text-xs px-1 rounded ${
                      m.confidence === 'high' ? 'bg-red-400/10 text-red-400' : 'bg-yellow-400/10 text-yellow-400'
                    }`}>
                      {m.confidence}
                    </span>
                  </div>
                  <div className="text-zinc-400 text-xs font-mono mt-0.5 truncate">{m.preview}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
