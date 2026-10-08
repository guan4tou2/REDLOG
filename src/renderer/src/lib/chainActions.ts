import { toast } from '../components/Toast'
import { raiseIssue, clearIssue } from './issues'
import { setLastVerifyResult, type FullVerifyResult as CachedFullVerifyResult } from './verifyResultCache'
import { settingsTarget } from './navigation'

// The two acts that answer an integrity fault, with the toast and the issue
// each result implies.
//
// They lived inside Settings ▸ Integrity, which is where they are *performed*
// and no longer the only place they are *reached*: the dashboard now offers
// the same two as the fix on the issue they belong to (§9). Two copies of
// "did the anchor land, and what does the issue list say now" is the kind of
// pair that agrees on the day it is written and not afterwards — so there is
// one copy, and the panel keeps only what is genuinely its own: the busy
// flags, the anchor list and the detail card.

type T = (key: string, vars?: Record<string, string | number>) => string

export interface FullVerifyResult {
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

/** Submit the current head for timestamping. Returns the anchor, so a caller
 *  showing the anchor list can reload it, or null when there was nothing to
 *  anchor. `onRetry` is offered on the failure toast. */
export async function anchorNowWithFeedback(t: T, onRetry?: () => void): Promise<ChainAnchorInfo | null> {
  const result = await window.redlog.chain.anchorNow()
  if (!result) {
    toast(t('settings.integrityNoAnchors'), {
      type: 'error',
      why: t('settings.integrityNoAnchorsWhy')
    })
    return null
  }
  const ok = result.calendarReceipts.filter((r) => r.ok).length
  const total = result.calendarReceipts.length
  if (ok > 0) {
    clearIssue('anchor')
    toast(t('settings.anchored', { ok, total }), 'success')
  } else {
    raiseIssue({
      id: 'anchor', tier: 'attention',
      title: t('settings.anchorFailed'), detail: t('settings.anchorFailedWhy'),
      view: settingsTarget('integrity'), fix: 'anchor-now'
    })
    toast(t('settings.anchorFailed'), {
      type: 'error',
      why: t('settings.anchorFailedWhy'),
      detail: result.calendarReceipts.map((r) => `${r.url ?? '?'}: ${r.error ?? 'no receipt'}`).join('\n'),
      ...(onRetry ? { action: { label: t('common.retry'), onClick: onRetry } } : {})
    })
  }
  return result
}

/** Walk every event, recompute each hash and check the latest anchor. Returns
 *  the full result for the detail card; the issue it implies is raised here. */
export async function verifyChainWithFeedback(t: T): Promise<FullVerifyResult> {
  const r = await window.redlog.chain.verify()
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
      detail: t(r.ok ? 'issues.chainAnchorMismatchDetail' : 'issues.chainBrokenDetail'),
      view: settingsTarget('integrity'), fix: 'verify-chain'
    })
  }
  return r
}
