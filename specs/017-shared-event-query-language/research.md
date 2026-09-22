# Research: Shared Event Query Language

- **Decision**: Introduce one query contract — structured conditions plus free
  text — evaluated at the persistence layer, with the Transcript as its first
  consumer. Search migrates in Spec 018.
- **Rationale for a language rather than a bare backend search**: the feature
  must support identifier conditions, and an identifier condition needs some
  way to be written. Without a language that means separate inputs per field or
  a second private convention, so the language is not additional scope — it is
  the scope, stated once.
- **Rationale for the Transcript first**: it has no backend query behaviour to
  regress, so the contract is proven by a consumer that cannot be broken by it.
  Migrating Search first would mean changing behaviour already Verified under
  Spec 008 against an abstraction nothing had used yet. It also unblocks the
  finding that prompted this work rather than queuing it behind a regression
  obligation.
- **Identifier cost is not uniform**, and this shaped scope: `id` is the primary
  key and `transcript_uuid` already has an index, so both are nearly free;
  `session_id` is a column needing one index; `tool_use_id` sits in the `data`
  JSON and needs an expression index. Transcript UUID was originally excluded
  and is included precisely because it is the cheapest of the four.
- **"Session" names two different identifiers.** The `session_id` column is
  RedLog's per-process capture session; `event-write.ts` already records that
  no consumer filters on it and that it survives a project reopen incorrectly.
  The identifier an operator actually holds — from an AI transcript, from the
  Timeline detail panel — is `data.session_id`, the agent's session. A draft
  that indexed the column would have shipped a condition that matches nothing
  an operator pastes. Found by writing the seeding for the resolution tests.
- **Tool-use IDs are unique only within a session.** `buildBlocks` already pairs
  on `${session_id}:${tool_use_id}`. An earlier draft of this spec required a
  bare tool-use ID to resolve "exactly", which the data does not support; a
  cross-session collision would have let counterpart completion attach the
  wrong half. Resolution is therefore session-scoped and the session is stated.
- **Alternative considered**: reuse the Spec 008 query per Transcript bucket
  with no language. Cheaper, and it satisfies the absence-proving requirement.
  Rejected because it leaves identifier lookup unexpressible while still
  requiring backend predicates for those fields, so the syntax question returns
  immediately with a second implementation already in place.
- **Alternative considered**: one spec covering both surfaces. Rejected after
  weighing the risk profiles: Transcript work is additive, Search work is
  non-regression on Verified behaviour, and a single gate over both would hold
  the additive half hostage to the regression half.
- **Alternative considered**: keeping pairing to the loaded set and telling the
  operator to load older pages. Rejected because it makes the operator perform
  the query the tool was asked to perform, and a half-shown exchange is exactly
  the partial result the surface must not present as whole.
- **Open for a later feature**: flow ID conditions, and whether the Timeline and
  Target views adopt the contract.
