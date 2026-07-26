import { useState, useCallback, useRef } from 'react'

const TYPE_COLORS: Record<string, string> = {
  shell: 'text-green-400',
  screenshot: 'text-blue-400',
  clipboard: 'text-yellow-400',
  file_transfer: 'text-purple-400',
  marker: 'text-red-400',
  loot: 'text-orange-400',
  system: 'text-zinc-400'
}

function eventSummary(e: RedLogEvent): string {
  const d = e.data
  if (e.agentType === 'shell') return `$ ${(d.command as string)?.slice(0, 120) || ''}`
  if (e.agentType === 'screenshot') return `Screenshot (${d.trigger})`
  if (e.agentType === 'clipboard') return `Clipboard: ${(d.content as string)?.slice(0, 80) || ''}`
  if (e.agentType === 'marker') return `[${d.severity}] ${d.title}`
  if (e.agentType === 'file_transfer') return `${d.direction}: ${d.filename || d.localPath || d.remotePath}`
  if (e.agentType === 'loot') return `Loot: ${d.type} (${d.confidence})`
  return `${e.agentType}: ${d.subtype || JSON.stringify(d).slice(0, 60)}`
}

export function SearchPanel(): JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<RedLogEvent[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const doSearch = useCallback((q: string) => {
    if (q.length < 2) {
      setResults([])
      setSearched(false)
      return
    }
    setSearching(true)
    window.redlog.events.search(q, 200).then((r) => {
      setResults(r)
      setSearching(false)
      setSearched(true)
    })
  }, [])

  const onChange = useCallback((val: string) => {
    setQuery(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(val), 300)
  }, [doSearch])

  return (
    <div className="p-4 h-full flex flex-col">
      <div className="relative mb-3 shrink-0">
        <input
          value={query}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search commands, targets, clipboard, loot..."
          autoFocus
          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2.5 text-sm text-zinc-200 font-mono focus:outline-none focus:border-red-500 placeholder-zinc-600"
        />
        {searching && (
          <span className="absolute right-3 top-3 text-zinc-500 text-xs animate-pulse">...</span>
        )}
      </div>

      <div className="flex-1 overflow-auto min-h-0">
        {!searched && !searching && (
          <div className="text-zinc-600 text-sm text-center mt-8">
            Type at least 2 characters to search across all events
          </div>
        )}
        {searched && results.length === 0 && (
          <div className="text-zinc-600 text-sm text-center mt-8">
            No results for "{query}"
          </div>
        )}
        {results.length > 0 && (
          <>
            <div className="text-zinc-500 text-xs mb-2">{results.length} results</div>
            <div className="space-y-1">
              {results.map((e) => (
                <div key={e.id} className="flex items-start gap-2 px-3 py-2 rounded hover:bg-zinc-800/50 text-xs">
                  <span className={`font-mono font-bold w-12 shrink-0 ${TYPE_COLORS[e.agentType] || 'text-zinc-400'}`}>
                    {e.agentType.slice(0, 6)}
                  </span>
                  <span className="text-zinc-300 font-mono flex-1 min-w-0 truncate">
                    {eventSummary(e)}
                  </span>
                  <span className="text-zinc-600 shrink-0 ml-2">
                    {new Date(e.timestamp).toLocaleTimeString()}
                  </span>
                  {e.targetId && (
                    <span className="text-zinc-500 shrink-0 ml-1">→ {e.targetId}</span>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
