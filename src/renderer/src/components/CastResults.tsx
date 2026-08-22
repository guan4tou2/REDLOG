import { useState, useEffect } from 'react'
import { Terminal, ChevronRight, ChevronDown } from 'lucide-react'
import { useI18n } from '../i18n'
import { formatTime } from '../lib/time'

// Search hits inside terminal recordings (docs/DESIGN-core-and-capture.md
// §2.4).
//
// The question this answers is "where is the output of that scan" — so the
// row's primary action is to show the output, read back from the `.cast` by
// byte range, rather than to jump somewhere else and make the operator find
// it again. Jumping to the moment on the timeline is the secondary action,
// because it answers a different question ("what else was happening then").

export interface CastHit {
  castRel: string
  tMs: number
  off: number
  len: number
  snippet: string
}

interface Props {
  hits: CastHit[]
  /** Recordings on disk that the index has not read yet. */
  pending: number
  onOpenAt?: (tMs: number) => void
}

function CastRow({ hit, onOpenAt }: { hit: CastHit; onOpenAt?: (tMs: number) => void }): JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [body, setBody] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!open || body !== null || failed) return
    let live = true
    window.redlog.events
      .readCastRange(hit.castRel, hit.off, hit.len)
      .then((r) => { if (live) { if (r) setBody(r.text); else setFailed(true) } })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [open, body, failed, hit.castRel, hit.off, hit.len])

  return (
    <div className="rounded border border-redlog-border-subtle">
      <div className="flex items-start gap-2 px-3 py-2 text-xs">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-start gap-2 flex-1 min-w-0 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 rounded"
          title={t('castSearch.showOutput')}
        >
          {open
            ? <ChevronDown size={13} strokeWidth={1.5} className="shrink-0 mt-0.5 text-redlog-text-dim" aria-hidden />
            : <ChevronRight size={13} strokeWidth={1.5} className="shrink-0 mt-0.5 text-redlog-text-dim" aria-hidden />}
          <span className="text-redlog-text font-mono flex-1 min-w-0 truncate" title={hit.snippet}>
            {hit.snippet}
          </span>
        </button>
        <span className="text-redlog-text-faint shrink-0 tabular-nums">{formatTime(hit.tMs, { seconds: true })}</span>
        {onOpenAt && (
          <button
            onClick={() => onOpenAt(hit.tMs)}
            title={t('castSearch.openAtMoment')}
            aria-label={t('castSearch.openAtMoment')}
            className="shrink-0 text-redlog-text-dim hover:text-redlog-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 rounded px-1"
          >↗</button>
        )}
      </div>
      {open && (
        <pre className="px-3 pb-2 text-xs font-mono text-redlog-text-dim whitespace-pre-wrap break-all max-h-64 overflow-auto">
          {failed ? t('castSearch.unreadable') : body ?? t('castSearch.reading')}
        </pre>
      )}
    </div>
  )
}

export function CastResults({ hits, pending, onOpenAt }: Props): JSX.Element | null {
  const { t } = useI18n()
  if (hits.length === 0 && pending === 0) return null

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2 mb-2">
        <Terminal size={13} strokeWidth={1.5} className="text-redlog-text-dim" aria-hidden />
        <h2 className="text-xs font-semibold text-redlog-text-dim uppercase tracking-[0.15em]">
          {t('castSearch.heading')}
        </h2>
        <span className="text-xs text-redlog-text-faint tabular-nums">{hits.length}</span>
      </div>

      {/* Not decoration. A project whose recordings are still being read
          returns fewer hits than it will in a minute, and the one thing this
          product cannot do is let that read as "nothing there". */}
      {pending > 0 && (
        <p className="text-xs text-amber-500/80 mb-2" role="status">
          {t('castSearch.stillIndexing', { pending })}
        </p>
      )}

      <div className="space-y-1">
        {hits.map((h) => (
          <CastRow key={`${h.castRel}:${h.off}`} hit={h} onOpenAt={onOpenAt} />
        ))}
      </div>

      {hits.length > 0 && (
        <p className="text-xs text-redlog-text-faint mt-2">{t('castSearch.tokenNote')}</p>
      )}
    </div>
  )
}
