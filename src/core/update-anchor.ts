import { anchorNow as realAnchorNow, computeChainHead as realComputeChainHead, type ChainAnchor } from './chain-anchor'
import { insertEvent } from './db/events'
import { eventBus } from './event-bus'
import { getPrimaryOperator } from './db/operators'
import { getProjectDir } from './db/index'

export interface RestartAnchorResult {
  /** A calendar receipt came back (complete or partial) — the head is timestamped.
   *  `pending` means the anchor row exists but calendars have not confirmed yet;
   *  the renderer can surface that as "已提交，等待確認". */
  anchored: boolean
  headHash: string | null
  anchorStatus: 'complete' | 'partial' | 'failed' | 'pending' | 'none'
  /** What the OUTSIDE timestamp did, kept apart from whether this machine wrote
   *  its own record. `unavailable` and `skipped` are not reasons to stop an
   *  update (Spec 061 FR-007); a local failure is, and says so in `localError`. */
  external: 'confirmed' | 'unavailable' | 'skipped' | 'none'
  /** The chained marker row (and the chain head it names) could not be written
   *  or read. Null when it was written, or when there was nothing to write
   *  because no project is open. */
  localError: string | null
}

export interface AnchorBeforeRestartDeps {
  anchorNow?: () => Promise<ChainAnchor | null>
  computeChainHead?: () => { hash: string } | null
  /** Whether a project is open, i.e. whether there is a chain to mark. */
  projectOpen?: () => boolean
}

const defaultProjectOpen = (): boolean => {
  try { getProjectDir(); return true } catch { return false }
}

/** Design 5a — "重啟前先錨定鏈頭". Anchor the current chain head before an
 *  update-driven restart, then append a chained `system.update_pending` event
 *  recording the anchored head and that a recording gap is expected.
 *
 *  An update restart leaves a real hole in the capture stream: the app is down
 *  while the new build installs (the design discloses this as "約 8 秒不記錄").
 *  Marking the pause in the chain turns that hole into an attributed pause
 *  instead of a gap a reviewer could mistake for tampering.
 *
 *  Two different things can go wrong and they are not the same (Spec 061
 *  FR-006, FR-007). The marker row is this machine's own record: if it cannot
 *  be written, `localError` says so and the caller must not restart. The
 *  outside timestamp (OpenTimestamps calendars) is a courtesy: unreachable is
 *  reported in `external` and never blocks. With `offline` (air-gap) no request
 *  is made at all and the head is read locally.
 *
 *  No electron dependency (fromVersion is passed in) so the flow is
 *  unit-testable. No project open means no chain to mark: nothing is written
 *  and nothing has failed. */
export async function anchorBeforeRestart(
  opts: { fromVersion: string; toVersion?: string | null; engagementId?: string; offline?: boolean },
  deps: AnchorBeforeRestartDeps = {}
): Promise<RestartAnchorResult> {
  const anchorNow = deps.anchorNow ?? realAnchorNow
  const computeChainHead = deps.computeChainHead ?? realComputeChainHead
  if (!(deps.projectOpen ?? defaultProjectOpen)()) {
    return { anchored: false, headHash: null, anchorStatus: 'none', external: 'none', localError: null }
  }

  let anchorStatus: RestartAnchorResult['anchorStatus'] = 'none'
  let external: RestartAnchorResult['external'] = opts.offline ? 'skipped' : 'none'
  let headHash: string | null = null
  try {
    if (opts.offline) {
      headHash = computeChainHead()?.hash ?? null
    } else {
      // The calendar requests inside never throw; a throw here is the local
      // head read or the local anchor row.
      const anchor = await anchorNow()
      anchorStatus = anchor?.status ?? 'none'
      headHash = anchor?.headHash ?? null
      if (anchor) external = anchorStatus === 'complete' || anchorStatus === 'partial' ? 'confirmed' : 'unavailable'
    }
  } catch (e) {
    return { anchored: false, headHash: null, anchorStatus: 'none', external, localError: `chain head: ${(e as Error).message}` }
  }

  try {
    const primary = getPrimaryOperator()
    if (primary) {
      const ev = insertEvent('system', {
        subtype: 'update_pending',
        from_version: opts.fromVersion,
        to_version: opts.toVersion ?? null,
        anchored_head: headHash,
        anchor_status: anchorStatus,
        external_timestamp: external,
        gap_expected: true,
        description: external === 'skipped'
          ? '準備更新重啟：air-gap 模式，未對外送出時間戳；重啟安裝期間會有數秒不記錄'
          : `準備更新重啟：鏈頭已錨定（${anchorStatus}）；重啟安裝期間會有數秒不記錄`
      }, { engagementId: opts.engagementId ?? 'default', operatorId: primary.id })
      // A null is a row that was not stored (a duplicate inside the window is
      // the only legitimate reason, and a marker is never identical twice).
      if (!ev) return { anchored: false, headHash, anchorStatus, external, localError: 'marker row was not stored' }
      eventBus.publish(ev)
    }
  } catch (e) {
    return { anchored: false, headHash, anchorStatus, external, localError: `marker: ${(e as Error).message}` }
  }

  return {
    anchored: anchorStatus === 'complete' || anchorStatus === 'partial',
    headHash,
    anchorStatus,
    external,
    localError: null
  }
}

export interface UpdateOutcomeInput {
  kind: 'completed' | 'not-applied'
  fromVersion: string
  toVersion: string
  actualVersion: string
}

/** The first launch after an update restart writes down what actually
 *  happened, judged by the version that is running (Spec 061 FR-009). It says
 *  in the record that terminals and proxy connections from before the restart
 *  were ended and not resumed: a reviewer reading the gap should not have to
 *  guess, and nothing here claims a session came back. Returns the stored row,
 *  or null if there is no operator to write it under. */
export function recordUpdateOutcome(
  outcome: UpdateOutcomeInput,
  ctx: { engagementId: string; operatorId: string }
): ReturnType<typeof insertEvent> {
  const done = outcome.kind === 'completed'
  const ev = insertEvent('system', {
    subtype: done ? 'update_completed' : 'update_not_applied',
    from_version: outcome.fromVersion,
    to_version: outcome.toVersion,
    actual_version: outcome.actualVersion,
    sessions_resumed: false,
    description: done
      ? `已更新到 ${outcome.actualVersion}（原 ${outcome.fromVersion}）；更新前開啟的終端與代理連線已結束，不會自動恢復`
      : `更新沒有完成：目前仍是 ${outcome.actualVersion}，預期 ${outcome.toVersion}`
  }, { engagementId: ctx.engagementId, operatorId: ctx.operatorId })
  if (ev) eventBus.publish(ev)
  return ev
}
