import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { usePivotRead, type ActivePivot } from '../lib/usePivots'
import { formatFreshness, formatTime } from '../lib/time'
import { Button } from './Button'
import { useTick } from '../lib/useTick'

/** Mirrors the main-process limit in active-pivots.ts. */
const PIVOT_LIST_CAP = 5

type Tone = 'ok' | 'warn' | 'err' | 'neutral'
const TONE: Record<Tone, string> = {
  ok: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
  warn: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  err: 'border-redlog-danger/50 bg-redlog-danger/10 text-red-300',
  neutral: 'border-redlog-border bg-redlog-elevated text-redlog-text-dim'
}
function Tag({ tone, testid, children }: { tone: Tone; testid?: string; children: React.ReactNode }): JSX.Element {
  return <span data-testid={testid} className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-xs ${TONE[tone]}`}>{children}</span>
}

/** Relay nodes RedLog has seen in commands. Listed, not drawn as a route: a
 *  detected node says nothing about which node forwards to which, nor that the
 *  channel is up now, so no arrows and no health. Independent of the IP read. */
function PivotNodes({ read }: { read: ReturnType<typeof usePivotRead> }): JSX.Element | null {
  const { t } = useI18n()
  // When this list was last read — what "updated" means here. Each node's own
  // time is when a command last mentioned it, which is a different fact.
  const [readAt, setReadAt] = useState<number | null>(null)
  useEffect(() => { if (read.status === 'ready') setReadAt(Date.now()) }, [read.status, read.pivots])
  if (read.status === 'loading') return null
  if (read.status === 'error') {
    return <div data-testid="pivot-error" className="pt-3 border-t border-redlog-border-subtle flex items-center gap-3 text-xs text-redlog-warn">
      <span>{read.pivots.length ? t('pivot.readFailedStale', { count: read.pivots.length }) : t('pivot.readFailed')}</span>
      <Button size="compact" onClick={read.retry}>{t('common.retry')}</Button>
    </div>
  }
  if (read.pivots.length === 0) return null
  const nodes: ActivePivot[] = read.pivots
  return <div data-testid="pivot-nodes" className="pt-3 border-t border-redlog-border-subtle space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-redlog-text-dim">
        <span>{t('pivot.activeTitle', { count: nodes.length })}</span>
        <span className="rounded border border-redlog-border px-1.5 font-mono text-xs text-redlog-text-faint">{t('pivot.listBadge')}</span>
      </p>
      {readAt !== null && <span className="font-mono text-xs text-redlog-text-faint">{t('ip.updatedAt', { time: formatTime(readAt, { seconds: true }) })}</span>}
    </div>
    <ul className="space-y-1.5">
      {nodes.map((p) => <li key={p.via + p.tool + p.ts} data-testid="pivot-node" className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded border border-redlog-border bg-redlog-elevated px-2.5 py-1.5 text-xs">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="rounded border border-cyan-700/50 bg-cyan-900/20 px-1 font-mono text-xs text-cyan-300">{p.tool}</span>
          <span className="font-mono text-redlog-text [overflow-wrap:anywhere]">{p.via}</span>
          {p.route && <span className="font-mono text-redlog-text-dim [overflow-wrap:anywhere]">{t('pivot.route', { route: p.route })}</span>}
        </span>
        <span className="font-mono text-redlog-text-faint whitespace-nowrap">{t('pivot.lastSeen', { when: formatFreshness(p.ts, t) })}</span>
      </li>)}
    </ul>
    <p className="text-xs text-redlog-text-faint">{t('pivot.unverified')}</p>
    {/* The list is capped (5 nodes, seen in the last 30 minutes), so a full list
        may be only part of it: say so instead of letting it read as complete. */}
    {nodes.length >= PIVOT_LIST_CAP && <p data-testid="pivot-cap-note" className="text-xs text-redlog-text-faint">{t('pivot.capNote', { count: PIVOT_LIST_CAP })}</p>}
  </div>
}

function CardHead({ tag, right }: { tag: JSX.Element; right?: string }): JSX.Element {
  const { t } = useI18n()
  return <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-semibold text-redlog-text">{t('ip.cardTitle')}</span>
      {tag}
    </div>
    {right && <span className="font-mono text-xs text-redlog-text-faint">{right}</span>}
  </div>
}

export default function IPStatusCard(): JSX.Element {
  const [status, setStatus] = useState<IPStatus | null>(null)
  const pivotRead = usePivotRead()
  const [failed, setFailed] = useState(false)
  useTick()
  const { t } = useI18n()

  // A failed read drops the previous status: an old address is not the current
  // one, and "could not read" is not "no address". The retry reuses the same
  // getStatus call as the first read.
  const read = useCallback((): void => {
    setFailed(false)
    window.redlog.ip.getStatus()
      .then((s) => { setStatus(s); setFailed(false) })
      .catch(() => { setStatus(null); setFailed(true) })
  }, [])

  useEffect(() => {
    read()
    const unsub = window.redlog.ip.onStatus(setStatus)
    return () => unsub()
  }, [read])

  const shell = 'rounded-lg bg-redlog-surface border border-redlog-border p-4 space-y-3 shadow-card'
  if (!status) {
    return (
      <div data-testid="ip-status-card" className={shell}>
        <CardHead tag={<Tag tone="neutral">{failed ? t('capture.readFailed') : t('ip.checking')}</Tag>} />
        {failed && <div className="space-y-2 text-xs text-redlog-text-dim">
          <p><span>{t('ip.readFailed')}</span> <span>{t('ip.readFailedStale')}</span></p>
          <Button size="compact" onClick={read}>{t('ip.recheck')}</Button>
        </div>}
        <PivotNodes read={pivotRead} />
      </div>
    )
  }

  const safety = status.ipSafety
  const lookupFailed = !!status.error
  // The tag says how far the answer goes. A match against the operator's own
  // lists is a match, not a safety verdict; no match is "unconfirmed".
  const tag = lookupFailed ? <Tag tone="err" testid="ip-state">{t('ip.lookupFailed')}</Tag>
    : safety === 'safe' ? <Tag tone="ok" testid="ip-state">{t('ip.safeIp')}</Tag>
      : safety === 'exposed' ? <Tag tone="err" testid="ip-state"><span className="h-2 w-2 rounded-full bg-redlog-danger animate-pulse" />{t('ip.exposedIp')}</Tag>
        : <Tag tone="warn" testid="ip-state">{t('ip.unknownIp')}</Tag>

  return (
    <div data-testid="ip-status-card" className={shell}>
      <CardHead tag={tag} right={status.lastCheck ? t('ip.updatedAt', { time: formatTime(status.lastCheck, { seconds: true }) }) : undefined} />

      <dl className="space-y-2 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <dt className="text-redlog-text-dim">{t('ip.externalIp')}</dt>
          <dd className="m-0 text-right font-mono text-redlog-text [overflow-wrap:anywhere]">
            {lookupFailed
              ? <Tag tone="warn">{t('ip.externalUnknown')}</Tag>
              : <>{status.externalIP ?? '—'}{safety === 'unknown' && status.externalIP && <span className="ml-1.5 font-sans text-redlog-text-faint" title={t('ip.safetyHint', { page: t('settings.pageNetwork') })}>{t('ip.notOnSafeList')}</span>}</>}
          </dd>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <dt className="text-redlog-text-dim">{t('ip.internalIp')}</dt>
          <dd className="m-0 font-mono text-redlog-text [overflow-wrap:anywhere]">{status.internalIP ?? '—'}</dd>
        </div>
      </dl>

      {safety === 'exposed' && !lookupFailed && (
        <p className="text-xs text-red-400/90 flex items-start gap-1.5">
          <span className="shrink-0">⚠</span>
          <span>{t('ip.exposedHint')}</span>
        </p>
      )}

      {lookupFailed && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xs text-red-400 [overflow-wrap:anywhere]">{status.error}</p>
          <Button size="compact" onClick={read}>{t('ip.recheck')}</Button>
        </div>
      )}

      <PivotNodes read={pivotRead} />
    </div>
  )
}
