# Research: Shared Event Query Language

- **Decision**: Introduce one query contract — structured conditions plus free
  text — evaluated at the persistence layer, and move both Search and the
  Transcript onto it in this feature.
- **Rationale**: The two surfaces already ask the same question of the same
  store and answer it differently: Search evaluates text in SQL, the Transcript
  in the renderer over loaded blocks. Neither can express an identifier
  condition. Adding backend text to the Transcript alone would make a second
  private text path and leave the vocabularies split, which is the condition
  Canonical Domain Semantics exists to prevent.
- **Cost accepted**: Search's query handling is already Verified under Spec 008,
  so this feature carries an explicit non-regression obligation — queries valid
  before must select the same events after. That obligation is a first-phase
  test, not a closing check.
- **Alternative considered**: Reuse the Spec 008 query per Transcript bucket
  with no language, deferring the DSL. Cheaper and lower risk, and it would
  satisfy the absence-proving requirement. Rejected because it leaves identifier
  lookup unexpressible and defers the shared vocabulary without removing the
  need for it — the second implementation would be built and then replaced.
- **Alternative considered**: Keeping pairing to the loaded set and telling the
  operator to load older pages. Rejected because it makes the operator perform
  the query the tool was asked to perform, and a half-shown exchange is exactly
  the partial result the surface must not present as whole.
- **Open for a later feature**: flow ID and transcript UUID conditions, and
  whether the Timeline and Target views join the same contract. The language is
  required to admit them without changing what existing queries mean.
