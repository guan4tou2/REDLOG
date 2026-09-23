# Research: One Scope Classifier

- **Decision**: One classification procedure in `scope-evaluator.ts`, with the
  filter status and the distance as two views of it. Authority and severity
  stay in the alert subsystem as a mapping over the distance.
- **Rationale**: The distance is a fact about the target and the scope; how
  alarming a distance is, is a policy choice. Putting both in one function
  inside `alert/` made export masking depend on alerting to learn a fact. The
  split keeps the fact where the domain says it lives and leaves the policy
  with its owner.
- **Evidence for FR-002**: a probe of both classifiers over one adjacent host
  in six written forms. `evaluateScope` normalised every form; the adjacency
  rungs of `classifyScopeTarget` resolved only the bare lowercase form, and
  returned `unrelated` — a notice below the alert floor — for uppercase,
  trailing-dot, host:port and URL forms. The shell target extractor keeps the
  case the operator typed, so this is reachable from ordinary commands.
- **Evidence for FR-010**: found by the RED test, not by reading. The first
  draft of that test asserted the opposite failure — that exclude-only
  projects masked ordinary traffic — because the classifier alone would have
  done so. The test failed on its other assertion: `isOutOfScope` exits early
  when there is no allowlist, so the classifier was never asked and the
  excluded target escaped masking instead. The early exit is removed; the
  classifier already encodes "no allowlist means nothing is out of scope except
  what is excluded".
- **Alternative considered**: normalise at every call site. Rejected: it is
  how the two copies drifted in the first place, and it leaves the next caller
  to remember.
- **Alternative considered**: move authority and severity into
  `scope-evaluator.ts` too. Rejected: they are shared with the IP alarm, and
  would pull alert vocabulary into the domain module.
