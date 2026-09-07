import { useEffect } from 'react'
import { useReplaySession, replayStore } from '../lib/replayStore'
import { SessionReplayPlayer } from './SessionReplayPlayer'
import { useI18n } from '../i18n'

// §14: the session replayer as a drawer above the status bar, present only
// while a replay is open. It lives at the app level (outside the view-root),
// so switching views — dashboard, settings, back to timeline — never unmounts
// the player and never interrupts playback.
//
// §14 sketched this as a 56px transport strip; a real asciinema player needs
// its terminal on screen, so the drawer is the player's height. The value §14
// wanted — playback that survives navigation — is what this delivers.
export function ReplayDrawer(): JSX.Element | null {
  const session = useReplaySession()
  const { t } = useI18n()

  useEffect(() => {
    if (!session) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') replayStore.close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [session])

  if (!session) return null
  return (
    <div className="shrink-0 border-t border-redlog-border bg-redlog-surface" role="region" aria-label={t('replay.drawerLabel')}>
      <div className="flex items-center justify-between px-3 h-9 border-b border-redlog-border">
        <span className="text-xs font-semibold text-redlog-text-dim uppercase tracking-[0.12em]">{t('replay.title')}</span>
        <button
          onClick={() => replayStore.close()}
          aria-label={t('replay.close')}
          className="text-redlog-text-dim hover:text-redlog-text text-lg leading-none rounded px-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim"
        >✕</button>
      </div>
      <div className="px-3 pb-2">
        {/* Key on the open id: a new replay is a fresh terminal, not the last
            session's frames left on screen. */}
        <SessionReplayPlayer key={session.id} events={session.events} truncated={session.truncated} />
      </div>
    </div>
  )
}
