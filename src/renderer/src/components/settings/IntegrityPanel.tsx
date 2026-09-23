import { useState, useEffect } from 'react'
import { toast } from '../Toast'
import { raiseIssue, clearIssue } from '../../lib/issues'
import { setLastVerifyResult, type FullVerifyResult as CachedFullVerifyResult } from '../../lib/verifyResultCache'
import { formatDateTime } from '../../lib/time'
import { settingsTarget } from '../../lib/navigation'
import { FieldGroup } from './SettingsShared'

interface FullVerifyResult {
  ok: boolean
  walked?: number
  brokenAtEventId?: string | null
  brokenReason?: string | null
  currentHead?: string | null
  anchor?: ChainAnchorInfo | null
  anchorMatchesWalkedHead?: boolean
  clockAnomalies?: Array<{ eventId: string; reason: string }>
  signedCount?: number
  unsignedCount?: number
  badSignatureAtEventId?: string | null
}

// Chain state: anchors, the two-tier counter, and verification. Read-only —
// building the evidence pack itself moved to the shell's export control (SS10),
// because it is an action and this page is where you look at the chain.
export default function IntegrityPanel({ t }: { t: (key: string, vars?: Record<string, string | number>) => string }): JSX.Element {
  const [anchors, setAnchors] = useState<ChainAnchorInfo[]>([])
  const [busy, setBusy] = useState(false)
  // v0.6.87 E1: rich full-chain verify result, shown as a detail card.
  const [fullVerify, setFullVerify] = useState<FullVerifyResult | null>(null)
  const [verifying, setVerifying] = useState(false)

  const reload = async (): Promise<void> => {
    const list = await window.redlog.chain.anchors()
    setAnchors(list)
  }

  useEffect(() => { reload() }, [])

  const handleAnchor = async (): Promise<void> => {
    setBusy(true)
    const result = await window.redlog.chain.anchorNow()
    setBusy(false)
    if (result) {
      const ok = result.calendarReceipts.filter((r) => r.ok).length
      const total = result.calendarReceipts.length
      if (ok > 0) {
        clearIssue('anchor')
        toast(t('settings.anchored', { ok, total }), 'success')
      } else {
        raiseIssue({
          id: 'anchor', tier: 'attention',
          title: t('settings.anchorFailed'), detail: t('settings.anchorFailedWhy'), view: settingsTarget('integrity')
        })
        toast(t('settings.anchorFailed'), {
          type: 'error',
          why: t('settings.anchorFailedWhy'),
          detail: result.calendarReceipts.map((r) => `${r.url ?? '?'}: ${r.error ?? 'no receipt'}`).join('\n'),
          action: { label: t('common.retry'), onClick: () => { void handleAnchor() } }
        })
      }
      await reload()
    } else {
      toast(t('settings.integrityNoAnchors'), {
        type: 'error',
        why: t('settings.integrityNoAnchorsWhy')
      })
    }
  }

  // One verify, because the walk also checks the latest anchor. There was an
  // anchor-only button too, and only it raised the issue below; the walk,
  // which also finds a broken row, only filled its own card.
  const handleVerify = async (): Promise<void> => {
    setVerifying(true)
    setFullVerify(null)
    const r = await window.redlog.chain.verify()
    setVerifying(false)
    setFullVerify(r)
    // v0.6.89.5: publish to the module-level cache so a fresh Timeline mount
    // picks up the broken-chain state without another verify click.
    setLastVerifyResult(r as CachedFullVerifyResult | null)
    // A chain that will not verify is the most consequential condition the
    // app can be in, so it stays on the issue list until a verify passes (SS9).
    // A chain re-hashed end to end, or cut short, still walks cleanly; only
    // the anchor disagrees, and that is a broken chain too.
    const anchorBad = r.anchor != null && !r.anchorMatchesWalkedHead
    if (r.ok && !anchorBad) clearIssue('chain')
    else {
      raiseIssue({
        id: 'chain', tier: 'attention', title: t('issues.chainBroken'),
        detail: t(r.ok ? 'issues.chainAnchorMismatchDetail' : 'issues.chainBrokenDetail'), view: settingsTarget('integrity')
      })
    }
  }

  const statusColor = (s: string): string => {
    switch (s) {
      case 'complete': return 'bg-green-900/60 text-green-300'
      case 'partial': return 'bg-yellow-900/60 text-yellow-300'
      case 'failed': return 'bg-red-900/60 text-red-300'
      default: return 'bg-redlog-elevated text-redlog-text-dim'
    }
  }
  const statusLabel = (s: string): string => t(`settings.integrityStatus${s.charAt(0).toUpperCase() + s.slice(1)}`)

  return (
    <FieldGroup title={t('settings.integrity')}>
      <p className="text-xs text-redlog-text-faint">{t('settings.integrityHint')}</p>
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={handleAnchor}
          disabled={busy}
          className="px-3 py-1.5 text-xs rounded bg-redlog-danger text-redlog-on-danger hover:bg-redlog-danger-hover disabled:opacity-50"
        >
          {busy ? t('settings.integrityAnchoring') : t('settings.integrityAnchorNow')}
        </button>
        {/* v0.6.87 E1: walks every event, recomputes each hash, and checks
            it against `prev_hash`, then checks the latest anchor. Shows a
            detail card with walked count, broken-at (if any), current head,
            and anchor match. */}
        <button
          onClick={handleVerify}
          disabled={verifying}
          className="px-3 py-1.5 bg-redlog-elevated text-emerald-300 text-xs rounded hover:bg-redlog-elevated-hover disabled:opacity-50"
        >
          {verifying ? t('settings.integrityVerifying') : t('settings.integrityVerifyFull')}
        </button>
        <button
          onClick={async () => {
            const r = await window.redlog.chain.upgrade() as { upgraded: number; scanned: number } | null
            if (r) toast(t('settings.integrityUpgraded', { n: r.upgraded, m: r.scanned }), r.upgraded > 0 ? 'success' : 'info')
            await reload()
          }}
          className="px-3 py-1.5 bg-redlog-elevated text-redlog-text text-xs rounded hover:bg-redlog-elevated-hover"
        >
          {t('settings.integrityUpgradeAll')}
        </button>
      </div>
      {fullVerify && (
        <div className={`p-3 rounded border text-xs space-y-1 font-mono ${
          fullVerify.ok ? 'border-emerald-800 bg-emerald-950/30' : 'border-red-800 bg-red-950/30'
        }`}>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className={fullVerify.ok ? 'text-emerald-400' : 'text-red-400'}>
              <span aria-hidden="true">{fullVerify.ok ? '✓' : '✗'} </span>
              <span>{t(fullVerify.ok ? 'settings.integrityFullOk' : 'settings.integrityFullBroken')}</span>
            </span>
          </div>
          <div className="text-redlog-text-dim">
            {t('settings.integrityFullWalked', { n: String(fullVerify.walked ?? 0) })}
          </div>
          {!fullVerify.ok && fullVerify.brokenAtEventId && (
            <>
              <div className="text-red-400 break-all">
                {t('settings.integrityFullBrokenAt')}: {fullVerify.brokenAtEventId}
              </div>
              {fullVerify.brokenReason && (
                <div className="text-redlog-text-dim break-all">
                  {t('settings.integrityFullReason')}: {fullVerify.brokenReason}
                </div>
              )}
            </>
          )}
          {fullVerify.currentHead && (
            <div className="text-redlog-text-dim break-all">
              {t('settings.integrityHeadHash')}: {fullVerify.currentHead.slice(0, 32)}...
            </div>
          )}
          {fullVerify.anchor ? (
            <div className={fullVerify.anchorMatchesWalkedHead ? 'text-emerald-400' : 'text-amber-400'}>
              {fullVerify.anchorMatchesWalkedHead
                ? t('settings.integrityFullAnchorMatch')
                : t('settings.integrityFullAnchorMismatch')}
            </div>
          ) : fullVerify.ok && (
            <div className="text-redlog-text-dim">{t('settings.integrityFullNoAnchor')}</div>
          )}
          {fullVerify.clockAnomalies && fullVerify.clockAnomalies.length > 0 && (
            <div className="text-amber-400">
              {t('settings.integrityFullClockAnomalies', { n: String(fullVerify.clockAnomalies.length) })}
            </div>
          )}
        </div>
      )}
      {anchors.length === 0 ? (
        <p className="text-xs text-redlog-text-dim">{t('settings.integrityNoAnchors')}</p>
      ) : (
        <div className="space-y-1 max-h-[240px] overflow-y-auto">
          {anchors.map((a) => (
            <div key={a.id} className="p-2 rounded border border-redlog-border bg-redlog-surface/50">
              <div className="flex items-center gap-2 text-xs">
                <span className={`text-xs px-1.5 py-0.5 rounded ${statusColor(a.status)}`}>
                  {statusLabel(a.status)}
                </span>
                <span className="text-redlog-text-dim font-mono tabular-nums text-xs">
                  {formatDateTime(a.createdAt, { seconds: true })}
                </span>
                <span className="text-redlog-text-dim text-xs">
                  {t('settings.integrityEvents').replace('{{n}}', String(a.eventCount))}
                </span>
              </div>
              <p className="text-xs text-redlog-text-dim font-mono mt-1 break-all">
                <span className="text-redlog-text-faint">{t('settings.integrityHeadHash')}: </span>{a.headHash.slice(0, 32)}...
              </p>
              <div className="flex flex-wrap gap-1 mt-1">
                {a.calendarReceipts.map((r, i) => (
                  <span
                    key={i}
                    title={r.ok
                      ? `${r.calendar} — ${r.upgradedBytes ?? r.receiptB64?.length ?? 0} B ${r.upgraded ? '(UPGRADED)' : '(pending)'}`
                      : `${r.calendar} — ${r.error}`}
                    className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                      r.upgraded ? 'bg-blue-900/50 text-blue-300' :
                      r.ok ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'
                    }`}
                  >
                    {new URL(r.calendar).hostname.split('.').slice(-3).join('.')}
                    {r.upgraded && ' ✓'}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </FieldGroup>
  )
}
