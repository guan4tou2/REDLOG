import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from './Button'
import { toast } from './Toast'
import { useI18n } from '../i18n'
import { formatDateTime, formatWhen, useDisplayZone } from '../lib/time'
import { useReadState } from '../lib/readState'
import { ANCHOR_DEAD_HOURS } from '../lib/integrityPulse'
import { anchorNowWithFeedback, upgradeAnchorsWithFeedback, verifyChainWithFeedback, verifyVerdict, type FullVerifyResult, type VerifyVerdict } from '../lib/chainActions'
import { getLastVerification, VERIFY_UPDATED_EVENT, type VerifyRecord } from '../lib/verifyResultCache'

// Is the evidence intact? The Evidence page's answer, above every tab (owner's
// ruling 6, 2026-11-12: verification moved here from Settings).
//
// The block never says more than was checked. The result is this run's last
// walk or nothing ("not verified yet" after a restart); it names when it ran
// and how many entries it walked, and entries that arrived since are named as
// not verified, so a tick never covers rows nobody walked. The headline is the
// shared verdict, so an anchor mismatch or incomplete signatures never read
// "intact". Below it, what is known without walking: the chain's length and
// the latest anchor, a failed or stale one worded as such.

type Translate = (key: string, vars?: Record<string, string | number>) => string

// The headline names the worst thing the verdict found; the line that would
// repeat it further down is left out. Each carries a shape as well as a colour.
const VERDICT_KEY: Record<VerifyVerdict, string> = {
  broken: 'settings.integrityFullBroken',
  'anchor-mismatch': 'settings.integrityFullAnchorMismatch',
  'signatures-incomplete': 'settings.integrityFullAuthFailed',
  intact: 'settings.integrityFullOk'
}
// The anchor-mismatch string carries its own ⚠.
const VERDICT_MARK: Record<VerifyVerdict, string> = { broken: '✗', 'anchor-mismatch': '', 'signatures-incomplete': '▲', intact: '✓' }
const VERDICT_TEXT: Record<VerifyVerdict, string> = {
  broken: 'text-red-400', 'anchor-mismatch': 'text-red-400', 'signatures-incomplete': 'text-amber-400', intact: 'text-emerald-400'
}

const STATUS_CLASS: Record<string, string> = {
  complete: 'bg-green-900/60 text-green-300',
  partial: 'bg-yellow-900/60 text-yellow-300',
  failed: 'bg-red-900/60 text-red-300'
}
const statusLabel = (t: Translate, s: string): string => t(`settings.integrityStatus${s.charAt(0).toUpperCase() + s.slice(1)}`)

const n = (v: number): string => v.toLocaleString()

/** The last result's one line: when, the verdict, how many were walked, and
 *  what arrived after. */
function ResultLine({ record, chainLen, t }: { record: VerifyRecord | null; chainLen: number | null; t: Translate }): JSX.Element {
  if (!record) return <span data-testid="evidence-verify-result" className="text-redlog-text-dim">{t('evidence.notVerified')}</span>
  const r = record.result as FullVerifyResult
  const verdict = verifyVerdict(r)
  const walked = r.walked ?? 0
  // A broken walk stopped at the break: the rows after it are not "added
  // since", they were never reached, and the verdict already says so.
  const since = verdict === 'broken' || chainLen === null ? null : chainLen - walked
  return <span data-testid="evidence-verify-result" className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-redlog-text-dim">
    <span>{t('evidence.verifiedAt', { time: formatWhen(record.verifiedAt, { seconds: true }) })}</span>
    <span className={`font-semibold ${VERDICT_TEXT[verdict]}`}>
      {VERDICT_MARK[verdict] && <span aria-hidden="true">{VERDICT_MARK[verdict]} </span>}{t(VERDICT_KEY[verdict])}
    </span>
    <span>{t('settings.integrityFullWalked', { n: n(walked) })}</span>
    {since !== null && since > 0 && <span className="text-amber-400">{t('evidence.addedSince', { n: n(since) })}</span>}
    {since !== null && since < 0 && <span className="text-amber-400">{t('evidence.changedSince')}</span>}
  </span>
}

/** The lines of the last result that the headline does not already say. */
function ResultDetail({ r, t }: { r: FullVerifyResult; t: Translate }): JSX.Element {
  const verdict = verifyVerdict(r)
  const anchored = r.anchor != null
  return <ul data-testid="evidence-verify-detail" className="space-y-0.5 font-mono text-xs text-redlog-text-dim">
    {r.signedCount !== undefined && (
      <li className={r.authentication === 'failed' ? 'text-amber-400' : undefined}>
        {t('settings.integrityFullSignatures', { signed: n(r.signedCount), unchecked: n((r.unsignedCount ?? 0) + (r.noPubKeyCount ?? 0)) })}
      </li>
    )}
    {r.authentication === 'failed' && r.ok && <>
      {r.authenticationReasons?.map((reason) => <li key={reason} className="break-all text-amber-400">{reason}</li>)}
      {r.firstUncheckedEventId && <li className="break-all text-amber-400">{r.firstUncheckedEventId}</li>}
    </>}
    {!r.ok && r.brokenAtEventId && <li className="break-all text-red-400">{t('settings.integrityFullBrokenAt')}: {r.brokenAtEventId}</li>}
    {!r.ok && r.brokenReason && <li className="break-all">{t('settings.integrityFullReason')}: {r.brokenReason}</li>}
    {anchored && verdict !== 'anchor-mismatch' && r.ok && r.anchorMatchesWalkedHead && <li>{t('settings.integrityFullAnchorMatch')}</li>}
    {!anchored && r.ok && <li>{t('settings.integrityFullNoAnchor')}</li>}
    {r.clockAnomalies && r.clockAnomalies.length > 0 && (
      <li className="text-amber-400">{t('settings.integrityFullClockAnomalies', { n: String(r.clockAnomalies.length) })}</li>
    )}
  </ul>
}

/** One earlier anchor: status, time, count, head and each calendar's receipt. */
function AnchorCard({ a, t }: { a: ChainAnchorInfo; t: Translate }): JSX.Element {
  return <div data-testid="anchor-card" className="rounded border border-redlog-border bg-redlog-surface/50 p-2">
    <div className="flex items-center gap-2 text-xs">
      <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_CLASS[a.status] ?? 'bg-redlog-elevated text-redlog-text-dim'}`}>{statusLabel(t, a.status)}</span>
      <span className="font-mono text-xs tabular-nums text-redlog-text-dim">{formatDateTime(a.createdAt, { seconds: true })}</span>
      <span className="text-xs text-redlog-text-dim">{t('settings.integrityEvents', { n: n(a.eventCount) })}</span>
    </div>
    <p className="mt-1 break-all font-mono text-xs text-redlog-text-dim">
      <span className="text-redlog-text-faint">{t('settings.integrityHeadHash')}: </span>{a.headHash.slice(0, 32)}…
    </p>
    {a.calendarReceipts.length > 0 && <div className="mt-1 flex flex-wrap gap-1">
      {a.calendarReceipts.map((r, i) => (
        <span key={i}
          title={r.ok ? `${r.calendar} — ${r.upgradedBytes ?? r.receiptB64?.length ?? 0} B ${r.upgraded ? '(UPGRADED)' : '(pending)'}` : `${r.calendar} — ${r.error}`}
          className={`rounded px-1.5 py-0.5 font-mono text-xs ${r.upgraded ? 'bg-redlog-cyan/15 text-redlog-cyan' : r.ok ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'}`}>
          {calendarHost(r.calendar)}{r.upgraded && ' ✓'}{!r.ok && ' ✗'}
        </span>
      ))}
    </div>}
  </div>
}

function calendarHost(url: string): string {
  try { return new URL(url).hostname.split('.').slice(-3).join('.') } catch { return url }
}

/** The latest anchor as one line, worded by its state. A failed submission
 *  and a day-old one say so; "not anchored yet" is only for no anchor. */
function AnchorLine({ anchors, chainLen, skipped, t, now }: {
  anchors: ChainAnchorInfo[]; chainLen: number | null; skipped: boolean; t: Translate; now: number
}): JSX.Element {
  const latest = anchors[0]
  // What is timestamped externally is what the last anchor that did not fail
  // covers; a failed submission timestamped nothing.
  const landed = anchors.find((a) => a.status !== 'failed')
  const unanchored = chainLen === null ? null : chainLen - (landed?.eventCount ?? 0)
  const hours = latest ? Math.floor((now - latest.createdAt) / 3_600_000) : 0
  return <span className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
    {!latest ? <span>{t('evidence.anchorNone')}</span> : <>
      <span className="font-mono tabular-nums">{formatWhen(latest.createdAt, { seconds: true })}</span>
      {latest.status === 'failed'
        ? <span className="text-red-400"><span aria-hidden="true">✗ </span>{t('issues.integrity.anchor-failed')}</span>
        : <span>{statusLabel(t, latest.status)}</span>}
      {latest.status !== 'failed' && hours >= ANCHOR_DEAD_HOURS && (
        <span className="text-amber-400"><span aria-hidden="true">▲ </span>{t('issues.integrity.anchor-stale', { days: Math.max(1, Math.floor(hours / 24)) })}</span>
      )}
    </>}
    {unanchored !== null && unanchored > 0 && <span className="font-mono">{t('evidence.unanchored', { n: n(unanchored) })}</span>}
    {skipped && <span>{t('settings.integritySkippedOffline')}</span>}
  </span>
}

export function EvidenceVerify(): JSX.Element {
  const { t } = useI18n()
  useDisplayZone()
  const project = useReadState(async () => (await window.redlog.project.active())?.id ?? null)
  const chainLen = useReadState<number>(() => window.redlog.chain.length())
  const anchors = useReadState<ChainAnchorInfo[]>(() => window.redlog.chain.anchors())
  const [record, setRecord] = useState<VerifyRecord | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [anchoring, setAnchoring] = useState(false)
  const [skipped, setSkipped] = useState(false)
  const projectId = project.state.value ?? null
  const { retry: rereadLength } = chainLen
  const { retry: rereadAnchors } = anchors

  // The cache is written by every walk (here, or the dashboard's fix button).
  useEffect(() => {
    const read = (): void => setRecord(getLastVerification(projectId))
    read()
    window.addEventListener(VERIFY_UPDATED_EVENT, read)
    return () => window.removeEventListener(VERIFY_UPDATED_EVENT, read)
  }, [projectId])

  // One re-read per burst of new events, so "added since" and "not anchored"
  // follow the chain while the page is open.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const unsub = window.redlog.events.onNewBatch(() => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => { rereadLength(); rereadAnchors() }, 1000)
    })
    return () => { unsub(); if (timer.current) clearTimeout(timer.current) }
  }, [rereadLength, rereadAnchors])

  const handleVerify = useCallback(async (): Promise<void> => {
    setVerifying(true)
    try {
      await verifyChainWithFeedback(t)
    } catch (e) {
      // The walk did not run: the last result (or "not verified yet") stands.
      toast(t('evidence.verifyFailed'), { type: 'error', detail: e instanceof Error ? e.message : String(e) })
    } finally {
      setVerifying(false)
      rereadLength()
    }
  }, [t, rereadLength])

  const handleAnchor = async (): Promise<void> => {
    setAnchoring(true)
    let wasSkipped = false
    const r = await anchorNowWithFeedback(t, () => { void handleAnchor() }, () => { wasSkipped = true })
    setAnchoring(false)
    setSkipped(wasSkipped)
    if (r) rereadAnchors()
  }

  const handleUpgrade = async (): Promise<void> => {
    await upgradeAnchorsWithFeedback(t)
    rereadAnchors()
  }

  const len = chainLen.state.phase === 'loaded' ? chainLen.state.value : null
  const anchorList = anchors.state.phase === 'loaded' ? anchors.state.value : null
  const older = anchorList ? anchorList.slice(1) : []

  return <section data-testid="evidence-verify" aria-label={t('evidence.verify')} className="space-y-2">
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
      <Button level="primary" size="compact" onClick={() => { void handleVerify() }} disabled={verifying}>
        {verifying ? t('settings.integrityVerifying') : t('evidence.verify')}
      </Button>
      {project.state.phase === 'loading'
        ? <span data-testid="evidence-verify-result" />
        : <ResultLine record={record} chainLen={len} t={t} />}
    </div>
    {record && <ResultDetail r={record.result as FullVerifyResult} t={t} />}
    <dl data-testid="evidence-chain-facts" className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-1 border-t border-redlog-border pt-2 text-xs text-redlog-text-dim">
      <dt className="text-redlog-text-faint">{t('evidence.chain')}</dt>
      <dd className="m-0 font-mono">
        {chainLen.state.phase === 'failed' ? t('evidence.readFailed') : len !== null ? t('settings.integrityEvents', { n: n(len) }) : ''}
      </dd>
      <dt className="text-redlog-text-faint">{t('evidence.anchor')}</dt>
      <dd className="m-0 flex min-w-0 flex-wrap items-center justify-between gap-2">
        {anchors.state.phase === 'failed'
          ? <span>{t('evidence.readFailed')}</span>
          : anchorList ? <AnchorLine anchors={anchorList} chainLen={len} skipped={skipped} t={t} now={Date.now()} /> : <span />}
        <span className="flex shrink-0 items-center gap-2">
          <Button level="quiet" size="compact" onClick={() => { void handleAnchor() }} disabled={anchoring}>
            {anchoring ? t('settings.integrityAnchoring') : t('settings.integrityAnchorNow')}
          </Button>
          <Button level="quiet" size="compact" onClick={() => { void handleUpgrade() }}>{t('settings.integrityUpgradeAll')}</Button>
        </span>
      </dd>
    </dl>
    {older.length > 0 && (
      <details className="text-xs text-redlog-text-dim">
        <summary className="cursor-pointer select-none text-redlog-text-faint hover:text-redlog-text">{t('evidence.olderAnchors', { n: older.length })}</summary>
        <div className="mt-1 space-y-1">{older.map((a) => <AnchorCard key={a.id} a={a} t={t} />)}</div>
      </details>
    )}
  </section>
}
