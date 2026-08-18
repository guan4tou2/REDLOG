// Public surface of the alert subsystem (v0.12.0).
//
//   producers  →  bus  →  policies  →  bus  →  surfaces
//
// Import from `@core/alert` — never from the sub-files directly, so we
// keep the freedom to reorganise internals. Sub-files are colocated for
// scannability, not because they're a stable file layout.

export type { Signal, IPChangeSignal, TargetHitSignal, SignalProducer } from './signal'

export type {
  Policy,
  Verdict,
  IPVerdict,
  IPVerdictKind,
  ScopeVerdict,
  ScopeDistance,
  CombinedVerdict,
  BurstVerdict,
  Authority,
  Severity
} from './policy'

export type {
  Surface,
  EmitContext,
  WebhookConfig,
  AdherenceRow,
  ViolationRow
} from './surface'

export { ChainEmitter, BadgeSurface, WebhookForwarder, AdherenceCounter, ViolationLog } from './surface'
export { AlertBus, type DerivedPolicy } from './bus'

export {
  IPPolicy,
  ScopePolicy,
  CombinedPolicy,
  BurstPolicy,
  type IPPolicyConfig,
  type ScopePolicyConfig,
  type CombinedPolicyConfig,
  type BurstPolicyConfig
} from './policies'
