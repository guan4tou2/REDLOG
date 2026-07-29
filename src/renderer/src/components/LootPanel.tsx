import { useState, useEffect } from 'react'
import { useI18n } from '../i18n'
import { HudPanel } from './Hud'

export function LootPanel(): JSX.Element {
  const [lootEvents, setLootEvents] = useState<Array<{
    timestamp: number
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
        timestamp: e.timestamp,
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
            <HudPanel key={i} tone="red"><div className="p-3">
              <div className="text-zinc-500 text-xs mb-2">
                {new Date(le.timestamp).toLocaleTimeString()} · {t('loot.items', { count: le.matches.length })}
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
            </div></HudPanel>
          ))}
        </div>
      )}
    </div>
  )
}
