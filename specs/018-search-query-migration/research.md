# Research: Search on the Shared Query Contract

- **Decision**: Migrate Search after Spec 017 is Verified, as its own feature
  with its own gate.
- **Rationale**: the two halves of "one query language" have different risk
  profiles. Teaching the Transcript to query the database is additive — there is
  no prior behaviour to break. Moving Search is a change to behaviour operators
  already depend on and that is already Verified. Combining them puts the
  additive half behind the regression half at one gate, and delays the finding
  that prompted the work.
- **The migration's real hazard is not performance or syntax** but silent
  meaning change: a query that was free text before may parse as a condition
  after. That is why the corpus is captured from the current implementation
  first, and why changed meanings are enumerated and accepted rather than
  discovered later by an operator concluding an absence from a narrowed query.
- **Alternative considered**: leave Search on its private query and accept two
  vocabularies. Rejected — it is the divergence Spec 017 exists to end, and it
  would leave identifier conditions available at only one of the two places an
  investigation starts.
