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
  AdherenceRow,
  ViolationRow
} from './surface'

export { ChainEmitter, BadgeSurface, AdherenceCounter, ViolationLog } from './surface'
export { AlertBus, type DerivedPolicy } from './bus'

export {
  classifyScopeTarget,
  buildScopeIndexes,
  isReportable,
  alertFloorFor,
  type ScopeSnapshot,
  type ScopeIndexes,
  IPPolicy,
  ScopePolicy,
  CombinedPolicy,
  BurstPolicy,
  type IPPolicyConfig,
  type ScopePolicyConfig,
  type CombinedPolicyConfig,
  type BurstPolicyConfig
} from './policies'

export { scopeSignalFor, SCOPE_ELIGIBLE, SCOPE_KEY_SQL, type ScopeSignalSource } from './scope-signal'
