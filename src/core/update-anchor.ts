import { anchorNow as realAnchorNow, type ChainAnchor } from './chain-anchor'
import { insertEvent } from './db/events'
import { eventBus } from './event-bus'
import { getPrimaryOperator } from './db/operators'

export interface RestartAnchorResult {
  /** A calendar receipt came back (complete or partial) — the head is timestamped.
   *  `pending` means the anchor row exists but calendars have not confirmed yet;
   *  the renderer can surface that as "已提交，等待確認". */
  anchored: boolean
  headHash: string | null
  anchorStatus: 'complete' | 'partial' | 'failed' | 'pending' | 'none'
}

export interface AnchorBeforeRestartDeps {
  anchorNow?: () => Promise<ChainAnchor | null>
}

/** Design 5a — "重啟前先錨定鏈頭". Anchor the current chain head before an
 *  update-driven restart, then append a chained `system.update_pending` event
 *  recording the anchored head and that a recording gap is expected.
 *
 *  An update restart leaves a real hole in the capture stream: the app is down
 *  while the new build installs (the design discloses this as "約 8 秒不記錄").
 *  Anchoring the head first, and marking the pause in the chain, turn that hole
 *  into an attributed, OpenTimestamps-anchored pause instead of a gap a reviewer
 *  could mistake for tampering. The anchor is the guarantee; the marker row is
 *  best-effort. No electron dependency (fromVersion is passed in) so the flow is
 *  unit-testable; safe with no chain or no operator (returns anchored:false). */
export async function anchorBeforeRestart(
  opts: { fromVersion: string; toVersion?: string | null; engagementId?: string },
  deps: AnchorBeforeRestartDeps = {}
): Promise<RestartAnchorResult> {
  const anchorNow = deps.anchorNow ?? realAnchorNow
  let anchor: ChainAnchor | null = null
  try {
    anchor = await anchorNow()
  } catch {
    anchor = null
  }
  const anchorStatus: RestartAnchorResult['anchorStatus'] = anchor?.status ?? 'none'
  const headHash = anchor?.headHash ?? null

  try {
    const primary = getPrimaryOperator()
    if (primary) {
      const ev = insertEvent('system', {
        subtype: 'update_pending',
        from_version: opts.fromVersion,
        to_version: opts.toVersion ?? null,
        anchored_head: headHash,
        anchor_status: anchorStatus,
        gap_expected: true,
        description: `準備更新重啟：鏈頭已錨定（${anchorStatus}）；重啟安裝期間會有數秒不記錄`
      }, { engagementId: opts.engagementId ?? 'default', operatorId: primary.id })
      if (ev) eventBus.publish(ev)
    }
  } catch {
    // The marker is best-effort — the anchor above is the actual guarantee.
  }

  return {
    anchored: anchorStatus === 'complete' || anchorStatus === 'partial',
    headHash,
    anchorStatus
  }
}
