// A built-in terminal's own target (#219).
//
// With several panes on several hosts, the global current target cannot say
// which pane is on which: switching it for one re-attributed what the others
// recorded next. Binding a pane gives its commands, markers and screenshots
// that pane's target instead; a host named in the command still wins. The
// binding is recorded as a `session_target_changed` event, and earlier rows
// are left exactly as they were attributed.

import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'

export function SessionTargetControl({ terminalId }: { terminalId: string }): JSX.Element {
  const { t } = useI18n()
  const [bound, setBound] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    let live = true
    setEditing(false)
    window.redlog.targetContext.getSession?.(terminalId)
      .then((v) => { if (live) setBound(v ?? null) })
      .catch(() => { if (live) setBound(null) })
    return () => { live = false }
  }, [terminalId])

  const bind = async (target: string | null): Promise<void> => {
    const r = await window.redlog.targetContext.bindSession(terminalId, target).catch(() => ({ ok: false, target: bound }))
    if (r.ok) setBound(r.target)
    setEditing(false)
  }

  if (editing) {
    return (
      <form
        data-testid="session-target-form"
        className="flex items-center gap-1"
        onSubmit={(e) => { e.preventDefault(); void bind(draft.trim() || null) }}
      >
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false) }}
          placeholder={t('terminal.sessionTargetPlaceholder')}
          aria-label={t('terminal.sessionTarget')}
          className="w-36 px-1.5 py-0.5 bg-redlog-elevated border border-redlog-border rounded text-xs font-mono text-redlog-text outline-none focus:border-redlog-accent/60"
        />
        <button type="submit" className="text-xs text-redlog-text-dim hover:text-redlog-text">{t('terminal.sessionTargetBind')}</button>
        {bound && (
          <button type="button" onClick={() => void bind(null)} className="text-xs text-redlog-text-faint hover:text-redlog-text">
            {t('terminal.sessionTargetUnbind')}
          </button>
        )}
      </form>
    )
  }

  return (
    <button
      data-testid="session-target"
      data-bound={bound ? 'true' : 'false'}
      onClick={() => { setDraft(bound ?? ''); setEditing(true) }}
      title={t('terminal.sessionTargetHint')}
      className={`max-w-[14rem] truncate px-1.5 py-0.5 rounded text-xs font-mono border ${
        bound ? 'border-redlog-accent/40 text-redlog-accent' : 'border-redlog-border text-redlog-text-faint hover:text-redlog-text'
      }`}
    >
      {bound ? t('terminal.sessionTargetBound', { target: bound }) : t('terminal.sessionTargetFollows')}
    </button>
  )
}
