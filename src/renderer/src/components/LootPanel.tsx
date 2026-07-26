import { useState, useEffect } from 'react'

export function LootPanel(): JSX.Element {
  const [lootEvents, setLootEvents] = useState<Array<{
    timestamp: number
    matches: Array<{ type: string; confidence: string; preview: string }>
  }>>([])
  const [lootCount, setLootCount] = useState(0)

  useEffect(() => {
    loadLoot()
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

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Loot ({lootCount})</h2>
      </div>

      {lootEvents.length === 0 ? (
        <div className="text-zinc-500 text-sm">
          <p>No credentials or secrets detected yet.</p>
          <p className="mt-1 text-xs">Auto-scans shell output for password hashes, API keys, JWTs, private keys, database URLs, and CTF flags.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {lootEvents.map((le, i) => (
            <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
              <div className="text-zinc-500 text-xs mb-2">
                {new Date(le.timestamp).toLocaleTimeString()} · {le.matches.length} item{le.matches.length > 1 ? 's' : ''}
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
