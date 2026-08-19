// AlertRuntime — one-object convenience wrapper around the alert
// subsystem. Bundles bus + all four policies + all five surfaces + the
// IP signal producer and provides one .configure() entry point.
//
// The alert subsystem itself doesn't depend on this — you could wire
// AlertBus + policies + surfaces by hand in main/index.ts. The runtime
// exists so main only has to think about "give me an alert runtime,
// configure it, subscribe to badge changes"; the policy/surface list is
// hidden.

import type { RedLogConfig } from '../../core/config'
import type { IPProducerState } from './producers/ip-signal-producer'
import {
  AlertBus,
  BadgeSurface,
  BurstPolicy,
  ChainEmitter,
  CombinedPolicy,
  IPPolicy,
  ScopePolicy,
  ViolationLog,
  WebhookForwarder,
  AdherenceCounter,
  type IPVerdict,
  type ViolationRow,
  type AdherenceRow,
  type TargetHitSignal
} from '../../core/alert'
import { IPSignalProducer } from './producers/ip-signal-producer'

/** The compat shape the StatusBar / IPStatusCard / overlay expect. The
 *  old IPMonitor exposed exactly this; the runtime composes it from the
 *  producer's state + the badge surface's verdict. Kept identical so the
 *  UI code doesn't need to change. */
export interface IPStatusShape {
  externalIP: string | null
  internalIP: string | null
  ipSafety: 'safe' | 'exposed' | 'unknown'
  lastCheck: number
  error: string | null
  settling: boolean
  link?: { type: 'wifi' | 'wired' | 'unknown'; name: string }
}

/** Maps the richer five-verdict alert semantics onto the three-colour
 *  badge the UI has always shown. `presumed_safe` reads as safe (we
 *  don't have positive-safe evidence, but nothing is red); `off_profile`
 *  reads as exposed (whitelist configured, IP didn't match — a real
 *  fact, deserves red). */
function verdictToSafety(v: IPVerdict | null): IPStatusShape['ipSafety'] {
  if (!v) return 'unknown'
  if (v.value === 'exposed' || v.value === 'off_profile') return 'exposed'
  if (v.value === 'safe' || v.value === 'presumed_safe') return 'safe'
  return 'unknown'
}

export class AlertRuntime {
  readonly bus: AlertBus
  readonly ipPolicy: IPPolicy
  readonly scopePolicy: ScopePolicy
  readonly combinedPolicy: CombinedPolicy
  readonly burstPolicy: BurstPolicy
  readonly chainEmitter: ChainEmitter
  readonly badgeSurface: BadgeSurface
  readonly webhookForwarder: WebhookForwarder
  readonly adherenceCounter: AdherenceCounter
  readonly violationLog: ViolationLog
  readonly ipProducer: IPSignalProducer

  constructor(initial: { engagementId: string; operatorId: string }) {
    this.bus = new AlertBus()
    this.ipPolicy = new IPPolicy()
    this.scopePolicy = new ScopePolicy()
    this.combinedPolicy = new CombinedPolicy()
    this.burstPolicy = new BurstPolicy()
    this.chainEmitter = new ChainEmitter(initial)
    this.badgeSurface = new BadgeSurface()
    this.webhookForwarder = new WebhookForwarder()
    this.adherenceCounter = new AdherenceCounter()
    this.violationLog = new ViolationLog()
    this.ipProducer = new IPSignalProducer(this.bus)

    // Registration order matters for one thing: surfaces run FIRST for
    // each emitted verdict (via bus.emit's surface loop), then derived
    // policies. That means ChainEmitter's audit event is written before
    // Combined/Burst reacts — so the causal chain is correct if the
    // derived policy then emits its own verdict (Combined lands AFTER
    // the source IP/Scope verdicts in the audit log).
    this.bus.registerSurface(this.chainEmitter)
    this.bus.registerSurface(this.badgeSurface)
    this.bus.registerSurface(this.webhookForwarder)
    this.bus.registerSurface(this.adherenceCounter)
    this.bus.registerSurface(this.violationLog)

    this.bus.registerPolicy(this.ipPolicy)
    this.bus.registerPolicy(this.scopePolicy)
    this.bus.registerPolicy(this.combinedPolicy)  // derived — bus routes via ingest
    this.bus.registerPolicy(this.burstPolicy)     // derived — bus routes via ingest
  }

  /** Apply a full config snapshot to every policy that reads config. Called
   *  on project open and on config:save. Also updates the ChainEmitter's
   *  engagement/operator context. Policies dedup internally so a no-op
   *  configure() call doesn't re-emit anything. */
  configure(cfg: RedLogConfig, ids: { engagementId: string; operatorId: string }, scopeTargets: string[]): void {
    this.chainEmitter.updateContext(ids)

    this.ipPolicy.configure({
      safeIps: cfg.network?.whitelist ?? [],
      exposedIps: cfg.network?.blacklist ?? []
    })
    this.scopePolicy.configure({
      targets: scopeTargets,
      excludeTargets: cfg.scope?.excludeTargets ?? [],
      // v0.11 had `warnOnViolation` as a single boolean gating everything.
      // The new alertFloor list is finer-grained; `warnOnViolation:false`
      // maps to "only in_scope and excluded emit" — every operator wants
      // the explicit-deny case fired regardless.
      alertFloor: cfg.scope?.warnOnViolation === false
        ? ['excluded']
        : ['excluded', 'adjacent_subnet', 'adjacent_domain']
    })

    this.webhookForwarder.configure({
      enabled: cfg.deconfliction?.enabled ?? false,
      url: cfg.deconfliction?.url ?? null,
      authorityFloor: ['fact']  // ea G-C2 — only facts hit the blue team's inbox
    })

    this.ipProducer.configure({
      checkIntervalSec: cfg.network?.checkInterval ?? 10,
      providers: cfg.network?.providers ?? [],
      confirmations: cfg.network?.confirmations ?? 3,
      ipMode: (cfg.network?.ipMode ?? 'auto') as 'dns' | 'http' | 'auto'
    })
  }

  /** Fire a scope-check for one observed target. Shell command_start,
   *  http_request_start, dns_message, agent tool call — all funnel here
   *  and hand the runtime a TargetHitSignal. */
  dispatchTargetHit(input: {
    target: string
    source: TargetHitSignal['source']
    action: string
    sourceEventId?: string | null
  }): void {
    this.bus.dispatch({
      kind: 'target_hit',
      timestamp: Date.now(),
      target: input.target,
      source: input.source,
      sourceEventId: input.sourceEventId ?? null,
      action: input.action
    })
  }

  /** IPC-compat: what the StatusBar / IPStatusCard have always read. */
  ipStatus(): IPStatusShape {
    const st = this.ipProducer.getState()
    return {
      externalIP: st.external,
      internalIP: st.internal,
      ipSafety: verdictToSafety(this.badgeSurface.get()),
      lastCheck: st.lastCheck,
      error: st.error,
      settling: st.settling,
      link: st.link
    }
  }

  /** IPC-compat: what the ScopePanel / StatusBar violation counter show. */
  scopeViolations(): ViolationRow[] { return this.violationLog.list() }
  scopeViolationCount(): number { return this.violationLog.count() }
  scopeIsConfigured(): boolean { return this.scopePolicy.isConfigured() }

  /** Adherence snapshot for the post-hoc scope report. */
  adherence(): AdherenceRow[] { return this.adherenceCounter.snapshot() }

  /** Called on project switch — drops correlation/burst history and the
   *  in-memory violation log; the chain-persisted history stays. */
  resetOnProjectSwitch(): void {
    this.bus.resetPolicies()
    this.violationLog.reset()
    this.adherenceCounter.reset()
  }

  /** Subscribe to badge changes so main can broadcast `ip:status` when the
   *  verdict flips. Returns an unsubscribe function. */
  onBadgeChange(fn: (v: IPVerdict | null) => void): () => void {
    return this.badgeSurface.subscribe(fn)
  }

  /** Subscribe to per-tick producer state updates. Fires every check —
   *  including no-address-change ticks — so the UI can refresh `lastCheck`
   *  and per-tick health signals. */
  onIpTick(fn: () => void): () => void {
    return this.ipProducer.onCheck(fn)
  }

  /** Producer link state — used by main's active-link monitor. */
  setLink(link: IPProducerState['link']): void {
    this.ipProducer.setLink(link)
  }

  start(): void { this.ipProducer.start() }
  stop(): void { this.ipProducer.stop() }
}
