import { useCallback, useEffect, useState } from 'react'
import { confirmGraded } from '../ConfirmDialog'
import { toast } from '../Toast'
import { formatDateTime } from '../../lib/time'

// Temp files the shell hooks wrote while no project was open. Replay cannot say
// which project they belong to, so it sets them aside as `*.unattributed` (#255).
// They say nothing about the open project's capture, so they are not on the
// dashboard's Capture Health card; this is the one place they are listed, for
// the operator who wants to look or clear them.

type Spool = { count: number; oldestAt: number; newestAt: number }

/** `2026-10-12 09:10` for one moment, `2026-10-12 09:10 – 2026-10-12 11:42` for
 *  a span. Two stamps in the same minute are one moment. */
function spoolRange(oldestAt: number, newestAt: number): string {
  const from = formatDateTime(oldestAt)
  const to = formatDateTime(newestAt)
  return from === to ? from : `${from} – ${to}`
}

export default function UnattributedSpoolRow({ t }: {
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element | null {
  const [spool, setSpool] = useState<Spool | null>(null)
  const refresh = useCallback(() => {
    window.redlog.capture.health()
      .then((h) => setSpool(h?.unattributedSpool ?? null))
      .catch(() => setSpool(null))
  }, [])
  useEffect(refresh, [refresh])
  if (!spool) return null

  // Graded `irreversible`: once the files go nothing can bring them back. What
  // is deleted is what is shown: the newest write time goes with the request so
  // a file set aside in the meantime survives.
  const clear = async (): Promise<void> => {
    const ok = await confirmGraded({
      title: t('capture.unattributedClearTitle', { count: spool.count }),
      message: t('capture.unattributedClearMessage'),
      level: 'irreversible',
      consequences: [
        t('capture.unattributedClearKeeps'),
        t('capture.unattributedClearGone', { range: spoolRange(spool.oldestAt, spool.newestAt) })
      ],
      ackLabel: t('capture.unattributedClearAck'),
      confirmLabel: t('capture.unattributedClearConfirm', { count: spool.count })
    })
    if (!ok) return
    try {
      const r = await window.redlog.capture.clearUnattributedSpool(spool.newestAt)
      if (r.failed > 0) toast(t('capture.unattributedClearFailed', { count: r.failed }), { type: 'error' })
      else toast(t('capture.unattributedCleared', { count: r.removed }))
    } catch (e) {
      toast(t('capture.unattributedClearFailed', { count: spool.count }), {
        type: 'error',
        detail: e instanceof Error ? e.message : String(e)
      })
    }
    refresh()
  }

  return (
    <div data-testid="capture-unattributed-spool" className="flex items-start gap-2 text-xs">
      <span className="flex-1 min-w-0 text-redlog-text-dim" title={t('capture.unattributedSpoolWhere')}>
        {t('capture.unattributedSpool', { count: spool.count, range: spoolRange(spool.oldestAt, spool.newestAt) })}
      </span>
      <button
        data-testid="capture-unattributed-clear"
        onClick={() => { void clear() }}
        className="shrink-0 text-redlog-text-dim hover:text-redlog-text underline"
      >
        {t('capture.unattributedClear')}
      </button>
    </div>
  )
}
