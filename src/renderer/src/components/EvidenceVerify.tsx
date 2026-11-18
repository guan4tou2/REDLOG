import { useCallback, useEffect, useId, useState } from 'react'
import { Button } from './Button'
import { IconButton } from './IconButton'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { toast } from './Toast'
import { useI18n } from '../i18n'
import { formatDateTime, formatWhen, useDisplayZone } from '../lib/time'
import { useReadState } from '../lib/readState'
import { createThrottledRead } from '../lib/throttledRead'
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

/** Something on the record that is not clean. `danger` is a fault in the
 *  record or its timestamping; `warn` qualifies what a tick may claim. */
interface Finding { id: string; tone: 'danger' | 'warn'; text: string; /** The fuller sentence, for the disclosure. */ detail?: string }
const TONE: Record<Finding['tone'], string> = { danger: 'text-red-400', warn: 'text-amber-400' }

interface Reading {
  record: VerifyRecord | null
  /** null while unknown; `lenFailed` says the read failed. */
  len: number | null
  lenFailed: boolean
  anchors: ChainAnchorInfo[] | null
  anchorsFailed: boolean
  skipped: boolean
  now: number
}

/** Every abnormal state the block knows of, worst first. The verdict is not
 *  among them: it has its own place on the line. */
function findings(r: Reading, t: Translate): Finding[] {
  const out: Finding[] = []
  const latest = r.anchors?.[0]
  if (latest?.status === 'failed') out.push({ id: 'anchor-failed', tone: 'danger', text: `✗ ${t('issues.integrity.anchor-failed')}` })
  if (r.record) {
    const verdict = verifyVerdict(r.record.result as FullVerifyResult)
    const walked = r.record.result.walked ?? 0
    // A broken walk stopped at the break: the rows after it were never
    // reached, and the verdict already says so.
    if (verdict !== 'broken') {
      if (r.lenFailed) out.push({ id: 'since-unknown', tone: 'warn', text: `▲ ${t('evidence.sinceUnknownShort')}`, detail: `▲ ${t('evidence.sinceUnknown')}` })
      else if (r.len !== null && r.len > walked) out.push({ id: 'added-since', tone: 'warn', text: `▲ ${t('evidence.addedSince', { n: n(r.len - walked) })}` })
      else if (r.len !== null && r.len < walked) out.push({ id: 'changed-since', tone: 'warn', text: `▲ ${t('evidence.changedSince')}` })
    }
  } else if (r.lenFailed) out.push({ id: 'length-failed', tone: 'warn', text: `▲ ${t('evidence.lengthFailed')}` })
  if (r.anchorsFailed) out.push({ id: 'anchors-failed', tone: 'warn', text: `▲ ${t('evidence.anchorsFailed')}` })
  if (latest && latest.status !== 'failed') {
    const hours = Math.floor((r.now - latest.createdAt) / 3_600_000)
    if (hours >= ANCHOR_DEAD_HOURS) out.push({ id: 'anchor-stale', tone: 'warn', text: `▲ ${t('issues.integrity.anchor-stale', { days: Math.max(1, Math.floor(hours / 24)) })}` })
  }
  if (r.skipped) out.push({ id: 'skipped-offline', tone: 'warn', text: `▲ ${t('settings.integritySkippedOffline')}` })
  return out
}

// The quiet parts of the line give way first; each keeps its full text in a title.
const QUIET = 'min-w-0 truncate text-redlog-text-dim'
const LOUD = 'shrink-0 whitespace-nowrap font-semibold'

/** The one line: when, the verdict, how many were walked, and the worst other
 *  finding, with a count of the rest. */
function ResultLine({ record, list, t }: { record: VerifyRecord | null; list: Finding[]; t: Translate }): JSX.Element {
  const r = record?.result as FullVerifyResult | undefined
  const verdict = r ? verifyVerdict(r) : null
  // One abnormal state on the line. A verdict that is not intact is it, unless
  // a warning verdict sits beside a fault in the timestamping, which is worse.
  const worst = !verdict || verdict === 'intact' || (verdict === 'signatures-incomplete' && list[0]?.tone === 'danger') ? list[0] : undefined
  const rest = list.length - (worst ? 1 : 0)
  const time = record ? t('evidence.verifiedAt', { time: formatWhen(record.verifiedAt, { seconds: true }) }) : ''
  const walked = r ? t('settings.integrityFullWalked', { n: n(r.walked ?? 0) }) : ''
  // Clean words may give way (an intact tick truncates before a warning
  // does); an abnormal one never does.
  const verdictClass = verdict === 'intact' ? `min-w-0 truncate font-semibold ${VERDICT_TEXT.intact}` : `${LOUD} ${verdict ? VERDICT_TEXT[verdict] : ''}`
  const verdictText = verdict ? t(verdict === 'anchor-mismatch' ? 'evidence.verdictMismatch' : VERDICT_KEY[verdict]) : ''
  return <span data-testid="evidence-verify-result" className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-xs tabular-nums">
    {!record || !verdict
      ? <span className="shrink-0 whitespace-nowrap text-redlog-text-dim">{t('evidence.notVerified')}</span>
      : <>
        <span className={QUIET} title={time}>{time}</span>
        <span className={verdictClass} title={verdictText}>
          <span aria-hidden="true">{VERDICT_MARK[verdict] || '⚠'} </span>{verdictText}
        </span>
      </>}
    {worst && <span className={`${LOUD} ${TONE[worst.tone]}`}>{worst.text}</span>}
    {rest > 0 && <span data-testid="evidence-verify-more" className={`${LOUD} text-redlog-text-dim`} title={list.slice(1).map((f) => f.text).join('\n')}>+{rest}</span>}
    {walked && <span className={QUIET} title={walked}>{walked}</span>}
  </span>
}

/** The lines of the last result that the headline does not already say. */
function ResultDetail({ r, t }: { r: FullVerifyResult; t: Translate }): JSX.Element {
  const verdict = verifyVerdict(r)
  const anchored = r.anchor != null
  return <ul data-testid="evidence-verify-detail" className="space-y-0.5 font-mono text-xs text-redlog-text-dim">
    {/* A broken walk counted signatures only up to the break. */}
    {r.ok && r.signedCount !== undefined && (
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
    {/* The walk compares with the latest anchor whatever its status. A failed
        one was never accepted by a calendar: its stored head may match, but
        it timestamps nothing, so "matches" would be a second green tick for
        an anchor that proves nothing. */}
    {anchored && verdict !== 'anchor-mismatch' && r.ok && r.anchorMatchesWalkedHead && (r.anchor as ChainAnchorInfo).status !== 'failed' && <li>{t('settings.integrityFullAnchorMatch')}</li>}
    {anchored && verdict !== 'anchor-mismatch' && r.ok && (r.anchor as ChainAnchorInfo).status === 'failed' && <li className="text-amber-400">▲ {t('evidence.anchorNeverAccepted')}</li>}
    {/* The line says "Anchor mismatch"; this is the sentence. */}
    {verdict === 'anchor-mismatch' && <li className="text-red-400">{t('settings.integrityFullAnchorMismatch')}</li>}
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

/** The latest anchor as one line: when, its status, and how many entries no
 *  landed anchor covers. A failed, stale or skipped anchor is a finding, said
 *  on the block's line and listed above this one. */
function AnchorLine({ anchors, chainLen, t }: { anchors: ChainAnchorInfo[]; chainLen: number | null; t: Translate }): JSX.Element {
  const latest = anchors[0]
  // What is timestamped externally is what the last anchor that did not fail
  // covers; a failed submission timestamped nothing.
  const landed = anchors.find((a) => a.status !== 'failed')
  const unanchored = chainLen === null ? null : chainLen - (landed?.eventCount ?? 0)
  return <span className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
    {!latest ? <span>{t('evidence.anchorNone')}</span> : <>
      <span className="font-mono tabular-nums">{formatWhen(latest.createdAt, { seconds: true })}</span>
      <span>{statusLabel(t, latest.status)}</span>
    </>}
    {unanchored !== null && unanchored > 0 && <span className="font-mono">{t('evidence.unanchored', { n: n(unanchored) })}</span>}
  </span>
}


/** The Evidence heading and, beside it, the block's one line; the rest of
 *  the block opens below them. The heading is passed in so the two share one
 *  row: the header is then no taller than the heading alone, which a short
 *  window at high zoom needs (the tabs must not push the page out of reach). */
export function EvidenceVerify({ heading }: { heading: JSX.Element }): JSX.Element {
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

  // "Added since" and "not anchored" follow the chain while the page is open:
  // at most one re-read a second under live batches, and a trailing one after
  // the last. A debounce re-armed per batch never fired under steady traffic,
  // which left "✓ intact" unqualified while rows kept chaining.
  useEffect(() => {
    const live = createThrottledRead({ read: () => { rereadLength(); rereadAnchors() }, minIntervalMs: 1000 })
    const unsub = window.redlog.events.onNewBatch(() => live.request())
    return () => { unsub(); live.dispose() }
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

  // A re-read keeps the last value on screen; a failed one shows nothing it
  // cannot stand behind.
  const len = chainLen.state.phase === 'failed' ? null : chainLen.state.value
  const anchorList = anchors.state.phase === 'failed' ? null : anchors.state.value
  const older = anchorList ? anchorList.slice(1) : []
  const shown = project.state.phase === 'loading' ? null : record
  const list = findings({
    record: shown, len, lenFailed: chainLen.state.phase === 'failed',
    anchors: anchorList, anchorsFailed: anchors.state.phase === 'failed', skipped, now: Date.now()
  }, t)
  const clean = !shown || verifyVerdict(shown.result as FullVerifyResult) === 'intact'

  // Open by default when the verdict is not clean; the operator's own toggle
  // wins until the next result arrives.
  const [openFor, setOpenFor] = useState<{ at: number | null; open: boolean }>({ at: null, open: false })
  const resultAt = shown?.verifiedAt ?? null
  const open = openFor.at === resultAt ? openFor.open : !clean
  const detailsId = useId()

  return <section data-testid="evidence-verify" aria-label={t('evidence.verify')} className="min-w-0">
    <div className="flex min-w-0 items-center gap-4">
      {heading}
      <div data-testid="evidence-verify-line" className="flex min-w-0 flex-1 items-center gap-2">
        <Button level="primary" size="compact" className="shrink-0" onClick={() => { void handleVerify() }} disabled={verifying}>
          {verifying ? t('settings.integrityVerifying') : t('evidence.verify')}
        </Button>
        {project.state.phase === 'loading'
          ? <span data-testid="evidence-verify-result" className="min-w-0 flex-1" />
          : <ResultLine record={shown} list={list} t={t} />}
        <IconButton label={t('evidence.details')} aria-expanded={open} aria-controls={detailsId}
          className="h-7 w-7 shrink-0 border border-redlog-border text-redlog-text-dim hover:bg-redlog-elevated hover:text-redlog-text"
          onClick={() => setOpenFor({ at: resultAt, open: !open })}>
          {open ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
        </IconButton>
      </div>
    </div>
    {open && <div id={detailsId} data-testid="evidence-verify-details" className="mt-2 max-h-[40vh] space-y-2 overflow-auto">
      {list.length > 0 && <ul className="space-y-0.5 font-mono text-xs">
        {list.map((f) => <li key={f.id} className={TONE[f.tone]}>{f.detail ?? f.text}</li>)}
      </ul>}
      {shown && <ResultDetail r={shown.result as FullVerifyResult} t={t} />}
      <dl data-testid="evidence-chain-facts" className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-1 border-t border-redlog-border pt-2 text-xs text-redlog-text-dim">
        <dt className="text-redlog-text-faint">{t('evidence.chain')}</dt>
        <dd className="m-0 font-mono">
          {chainLen.state.phase === 'failed' ? t('evidence.readFailed') : len !== null ? t('settings.integrityEvents', { n: n(len) }) : ''}
        </dd>
        <dt className="text-redlog-text-faint">{t('evidence.anchor')}</dt>
        <dd className="m-0 flex min-w-0 flex-wrap items-center justify-between gap-2">
          {anchors.state.phase === 'failed'
            ? <span>{t('evidence.readFailed')}</span>
            : anchorList ? <AnchorLine anchors={anchorList} chainLen={len} t={t} /> : <span />}
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
    </div>}
  </section>
}
