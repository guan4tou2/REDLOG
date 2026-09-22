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
- **There is no not-yet-indexed state to render here.** Search has one because
  it searches terminal recordings and `castIndexStatus` reports a backfill
  backlog; the Transcript searches stored event content and no equivalent
  pending signal exists. What does exist is a coverage gap: `command_end`
  carries `stdout`/`stderr` inline only when they were captured that way, and
  the external-shell hook records metadata with the bytes left in a recording.
  A term that would have matched those bytes finds nothing, so the Transcript
  states the limit of its reach rather than letting an operator read the empty
  result as absence.
- **A recognised prefix must stay writable as text.** The Spec 018 corpus made
  this concrete: today `event:ev-c-01` is four FTS tokens and selects the
  records that *quote* that ID. Under the contract it selects the record that
  *has* it — the change the feature exists to make — but "where was this ID
  pasted" is a real investigative move, and without an escape it stops being
  askable at all. An earlier draft rejected any quoting syntax for want of a
  requirement; this is the requirement.
- **Free text must keep the shape the store already gives it.** `toMatchQuery`
  quotes each term as an FTS5 phrase and appends `*` to the last one. The
  quoting is why `https://example.com/a`, `10.10.10.11` and `-sV` match as
  typed rather than being parsed as FTS operators; the trailing `*` is why
  type-ahead works at all, on a box that queries every keystroke. A parser
  written from scratch drops both silently, which is why they are requirements
  rather than implementation notes.
- **Open for a later feature**: flow ID conditions, and whether the Timeline and
  Target views adopt the contract.
