import { Button } from './Button'
// Pulled from the session's asciinema .cast on disk — not from the event
// row. Rendering here keeps the chain event clean (command + exit + duration
// only) while still letting the operator see what actually printed.

import { useState } from 'react'
import { replayStore } from '../lib/replayStore'
import { useI18n } from '../i18n'

export function ReplayCommand({ eventId, mode = 'command' }: { eventId: string; mode?: 'command' | 'session' }): JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)
  // Session replays play in the app-level drawer (survives view switches);
  // this flags that we handed one off so the inline area shows a pointer to it.
  const [inDrawer, setInDrawer] = useState(false)
  const { t } = useI18n()
  const load = async (): Promise<void> => {
    setLoading(true)
    try {
      const fn = mode === 'session'
        ? window.redlog.terminal.replaySession
        : window.redlog.terminal.replay
      const r = await fn?.(eventId)
      if (!r) { setError('unsupported'); return }
      if (!r.ok) { setError(r.error ?? 'failed'); return }
      const evs = (r as { events?: Array<[number, 'o', string]> }).events
      // A session with real frames goes to the drawer above the status bar, so
      // playback keeps running when the operator leaves the Timeline (§14).
      if (mode === 'session' && evs && evs.length > 0) {
        replayStore.open({ events: evs, truncated: Boolean((r as { truncated?: boolean }).truncated) })
        setInDrawer(true)
        return
      }
      // Command replay and empty session slices stay inline as text.
      setText(r.text ?? '')
      setExpanded(true)
    } finally {
      setLoading(false)
    }
  }
  const btnLabel = mode === 'session' ? 'timeline.replay.sessionButton' : 'timeline.replay.button'
  if (!expanded) {
    return (
      <div className="mt-1.5 flex items-center gap-2">
        <Button size="compact" level="quiet"
          onClick={load}
          disabled={loading}
        >{loading ? t('timeline.replay.loading') : t(btnLabel)}</Button>
        {/* Session replay lives in the drawer now; point the operator at it. */}
        {inDrawer && <span className="text-xs text-redlog-text-dim">▾ {t('timeline.replay.playingBelow')}</span>}
      </div>
    )
  }
  if (error) return <p className="mt-1.5 text-xs text-red-400">{t('timeline.replay.failed', { error })}</p>
  const heightCls = mode === 'session' ? 'max-h-[400px]' : 'max-h-[200px]'
  return (
    <pre className={`mt-1.5 p-2 bg-redlog-bg rounded border border-redlog-border text-xs text-redlog-text font-mono overflow-x-auto leading-relaxed ${heightCls} overflow-y-auto whitespace-pre-wrap`}>
      {text || t('timeline.replay.empty')}
    </pre>
  )
}
