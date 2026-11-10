// The ONE place the old "violation" vocabulary is allowed to survive (Spec 069
// FR-010, D1=A). The product says "out-of-scope observation"; these names are
// stored data and public contracts, so they keep their spelling:
//
//   scope_violation   events.data.subtype — inside the hash chain, in every old
//                     project and .redlog bundle, and in the JSONL hand-off.
//                     Rewriting it would break chain.verify().
//   warnOnViolation   config.yaml / profile key. Renaming needs a loader that
//                     reads the old key; that is its own change.
//   violation_id      the data field a scope_cleared event uses to name the
//                     event it clears.
//   scopeViolations,  response fields of the local HTTP API that scripts read.
//   violations,
//   violationCount
//
// Everything else — types, functions, IPC channels, i18n keys — uses
// "observation". Do not "finish the rename" on the names above.

export const SCOPE_VIOLATION_SUBTYPE = 'scope_violation'
