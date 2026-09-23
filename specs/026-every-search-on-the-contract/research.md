# Research: Every Search on the Query Contract

- **Decision**: Move the palette and the API onto the contract; remove the
  channel and function they no longer need.
- **Rationale**: Spec 018's goal was one meaning per query text. It was met for
  the two surfaces it named and missed for the two it did not. Each miss also
  carried a failure-swallowing path of the kind 018 removed elsewhere.
- **Empty query**: previously a property of `searchEventsPage` (no query, no
  results); the contract returned an unfiltered page. Surfaces guard against
  sending one, but a parsed `""` has empty text and no conditions, so the
  Transcript could have shown every event as results. Making the contract
  answer nothing keeps the old guarantee at the one place every caller shares.
- **Porting rather than rewriting**: a local helper maps the old call shape to
  the contract, so the assertions stay byte-for-byte as they were reviewed.
