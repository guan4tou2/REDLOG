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
export { AlertBus } from './bus'

export {
  classifyScopeTarget,
  isReportable,
  alertFloorFor,
  type ScopeSnapshot,
  IPPolicy,
  ScopePolicy,
  type IPPolicyConfig,
  type ScopePolicyConfig
} from './policies'

export { scopeSignalFor, SCOPE_ELIGIBLE, SCOPE_KEY_SQL, type ScopeSignalSource } from './scope-signal'
