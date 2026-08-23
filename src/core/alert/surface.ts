// The Surface layer of the alert subsystem (v0.12.0).
//
// A **Surface** consumes verdicts and produces side effects. Every I/O
// path exits through here — chain writes, badge updates, webhook posts,
// adherence counting. Policies stay pure by delegating all "landing"
// work to surfaces.
//
// Four bundled surfaces:
//   • ChainEmitter        — writes verdict as `system.*` event, chained/signed
//   • BadgeSurface        — updates the operator's IP badge state
//   • AdherenceCounter    — accumulates the post-hoc scope-adherence report
//
// Adding a Surface = implement the interface, register with AlertBus.
// Nothing else in the subsystem changes — that's what the seam buys.

import { insertEvent } from '../db/events'
import { eventBus } from '../event-bus'
import type { Verdict, IPVerdict, ScopeVerdict, Authority } from './policy'
import type { TargetHitSignal } from './signal'

/** A Surface receives every verdict the bus dispatches. Filtering (only
 *  care about `scope` verdicts? only forward `fact` tier?) is the surface's
 *  own responsibility — the bus fan-outs to all. */
export interface Surface {
  readonly name: string
  /** Called for each verdict. Async is allowed but must not block the
   *  dispatch loop — surfaces should fire-and-forget async I/O. */
  handle(verdict: Verdict): void | Promise<void>
}

// ─── ChainEmitter — writes verdicts as chained events ───────────────────────

export interface EmitContext {
  engagementId: string
  operatorId: string
}

/** Records verdicts as `system.*` events in the hash-chained log. Every
 *  verdict lands, regardless of severity or authority — the chain is the
 *  audit ground-truth. Filtering ("show only fact tier") happens later,
 *  at read time. */
export class ChainEmitter implements Surface {
  readonly name = 'chain'
  constructor(private ctx: EmitContext) {}

  updateContext(next: Partial<EmitContext>): void {
    if (next.engagementId) this.ctx.engagementId = next.engagementId
    if (next.operatorId) this.ctx.operatorId = next.operatorId
  }

  handle(verdict: Verdict): void {
    if (!this.ctx.operatorId) return  // pre-project-open, drop
    const { agentType, subtype, data, targetId } = this.formatEvent(verdict)
    try {
      const evt = insertEvent(agentType, {
        subtype,
        authority: verdict.authority,
        severity: verdict.severity,
        ...data
      }, {
        engagementId: this.ctx.engagementId,
        operatorId: this.ctx.operatorId,
        targetId
      })
      if (evt) eventBus.publish(evt)
    } catch { /* DB not ready — drop silently, capture-health catches this elsewhere */ }
  }

  private formatEvent(v: Verdict): {
    agentType: string
    subtype: string
    data: Record<string, unknown>
    targetId?: string
  } {
    switch (v.kind) {
      case 'ip':
        return {
          agentType: 'system',
          subtype: 'ip_verdict',
          data: ipEventFields(v)
        }
      case 'scope':
        return {
          agentType: 'system',
          subtype: 'scope_violation',
          data: {
            target: v.signal.target,
            action: v.signal.action.slice(0, 200),
            source: v.signal.source,
            distance: v.distance,
            ...(v.extractorPluginId ? {
              extractor_plugin_id: v.extractorPluginId,
              extractor_name: v.extractorName
            } : {}),
            ...(v.signal.sourceEventId ? { _causes: [v.signal.sourceEventId] } : {})
          },
          targetId: v.signal.target
        }
      case 'combined':
        return {
          agentType: 'system',
          subtype: 'combined_alert',
          data: {
            ip_value: v.ipValue,
            scope_distance: v.scopeDistance,
            correlation_ms: v.correlationMs,
            description: 'Both IP verdict and Scope verdict non-clean within recall window — see linked events for detail.'
          }
        }
      case 'burst':
        return {
          agentType: 'system',
          subtype: 'burst_alert',
          data: {
            distance: v.distance,
            count: v.count,
            window_ms: v.windowMs,
            first_at: v.firstAt,
            last_at: v.lastAt,
            targets: v.targets.slice(0, 10),
            description: `Burst: ${v.count} ${v.distance} verdicts in ${Math.round(v.windowMs / 1000)}s`
          }
        }
    }
  }
}

/** Exported for regression coverage — earlier revisions wrote `v.kind`
 *  (the outer discriminator, always `'ip'`) instead of `v.value` (the real
 *  verdict), which silently broke v0.13's tier classifier. Direct-call
 *  test in `test/alert/ip-event-fields.test.ts` locks the shape. */
export function ipEventFields(v: IPVerdict & { kind: 'ip' }): Record<string, unknown> {
  // Kind + modifiers land as top-level fields so downstream filters
  // (StatusBar badge, scope-adherence) can key on them
  // without decoding a nested object.
  return {
    ip_verdict_kind: v.value,
    ...(v.settling ? { settling: true } : {}),
    ...(v.stale ? { stale: true } : {}),
    ...(v.listConflict ? { list_conflict: true } : {}),
    ...(v.lanSafety ? { lan_safety: v.lanSafety } : {})
  }
}

// ─── BadgeSurface — updates IPMonitor-style external state ──────────────────

/** Provides the current IP-verdict view to the UI. Not a stateless emitter
 *  — the UI reads a live "what's the badge right now?" value out of this
 *  surface. Only IP verdicts update it (Self alarm shape); scope/combined
 *  verdicts flow through it but don't change the badge. */
export class BadgeSurface implements Surface {
  readonly name = 'badge'
  private current: (IPVerdict & { kind: 'ip' }) | null = null
  private listeners = new Set<(v: IPVerdict | null) => void>()

  handle(verdict: Verdict): void {
    if (verdict.kind !== 'ip') return
    this.current = verdict
    for (const l of this.listeners) { try { l(verdict) } catch { /* listener bug — drop */ } }
  }

  get(): (IPVerdict & { kind: 'ip' }) | null { return this.current }

  subscribe(fn: (v: IPVerdict | null) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}



// ─── AdherenceCounter — post-hoc scope-adherence tallies ────────────────────

export interface AdherenceRow {
  target: string
  distance: ScopeVerdict['distance']
  firstAt: number
  lastAt: number
  count: number
  sources: Set<TargetHitSignal['source']>
}

/** Accumulates the "247 targets, 244 in scope, 3 adjacent" positive
 *  proof. Read-only from the outside; snapshot for export bundle. */
export class AdherenceCounter implements Surface {
  readonly name = 'adherence'
  private byTarget = new Map<string, AdherenceRow>()

  handle(verdict: Verdict): void {
    if (verdict.kind !== 'scope') return
    const { target, source, timestamp } = verdict.signal
    const existing = this.byTarget.get(target)
    if (existing) {
      existing.count++
      existing.lastAt = timestamp
      existing.sources.add(source)
    } else {
      this.byTarget.set(target, {
        target,
        distance: verdict.distance,
        firstAt: timestamp,
        lastAt: timestamp,
        count: 1,
        sources: new Set([source])
      })
    }
  }

  snapshot(): AdherenceRow[] {
    return [...this.byTarget.values()]
  }

  reset(): void { this.byTarget.clear() }
}

// ─── ViolationLog — flat rolling list for the ScopePanel UI ─────────────────

export interface ViolationRow {
  target: string
  command: string
  timestamp: number
  distance: ScopeVerdict['distance']
}

/** Records every non-in-scope scope verdict for the operator-visible
 *  ScopePanel. Distinct from AdherenceCounter (which dedups by target
 *  for the post-hoc summary) — this preserves every occurrence, capped
 *  at `maxRows` so a long engagement doesn't leak memory. */
export class ViolationLog implements Surface {
  readonly name = 'violation-log'
  private rows: ViolationRow[] = []
  private maxRows: number

  constructor(maxRows = 500) { this.maxRows = maxRows }

  handle(verdict: Verdict): void {
    if (verdict.kind !== 'scope') return
    if (verdict.distance === 'in_scope') return
    this.rows.push({
      target: verdict.signal.target,
      command: verdict.signal.action.slice(0, 200),
      timestamp: verdict.signal.timestamp,
      distance: verdict.distance
    })
    if (this.rows.length > this.maxRows) this.rows.shift()
  }

  list(): ViolationRow[] { return [...this.rows] }
  count(): number { return this.rows.length }
  reset(): void { this.rows = [] }
}
