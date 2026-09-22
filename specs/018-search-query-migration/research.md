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

## T003 — Queries whose meaning the contract changes

Captured against `searchEventsPage` before Spec 017 exists in code. The corpus
is `test/search-query-corpus.json`, replayed by
`test/search-query-corpus.test.ts`; entry ids below are that file's.

What Search does with a query string today is one rule: split on whitespace,
quote each term as an FTS5 phrase, append `*` to the last one, and AND the
phrases. Nothing in the string is a condition, and the FTS tokeniser discards
`:`, `/`, `-` and `.` — so `event:ev-c-01` is the four adjacent tokens
`event ev c 01`, and it matches records that *quote* an identifier, never the
record that *has* it. That is the whole of the change: the contract moves four
prefixes from "text that happens to mention" to "field that equals".

### Changed — recommend accepting

These are what Spec 017 exists to add. In each case the two result sets are
disjoint or near-disjoint, so no operator is relying on today's meaning
deliberately; today's meaning is an accident of the tokeniser.

| Entry | Query | Selects today | Selects under the contract |
| --- | --- | --- | --- |
| Q14 | `event:ev-c-01` | `ev-l-05`, `ev-c-06` — the two records quoting the ID | `ev-c-01` — the record with the ID |
| Q15 | `session:sess-alpha` | `ev-c-07`, which merely names alpha | `ev-c-06`, whose event data carries agent session `sess-alpha` |
| Q16 | `tool:toolu-01` | `ev-c-07` | `ev-c-06` in the newest agent session, with that session stated (FR-004) |
| Q17 | `transcript:uuid-1111` | `ev-l-05`, `ev-c-08` — the records quoting the UUID | `ev-c-01` — the record carrying it |
| Q20 | `tool:toolu-01 follow-up` | `ev-c-07` — both tokens as text, ANDed | the resolved exchange intersected with the text `follow up` (FR-007) |

- **Decision (Q14, Q15, Q17)**: accept. Today's result is the set of records
  that *mention* an identifier, which is not a question an operator asks; the
  contract answers the one they do. Q15 is the sharpest case — today's single
  hit is in a different session from the one written in the query, so the
  present behaviour is actively misleading.
- **Condition on accepting**: the contract MUST offer a way to write the old
  query — the literal text `event:ev-c-01` — because "find the record that
  quotes this ID" is a real investigative move (it is how you find where an ID
  was pasted). Spec 017 FR-005 keeps *unrecognised* prefixes literal but says
  nothing about escaping a recognised one. If T004 finds no escape, the old
  query is not merely changed but unexpressible, and that is a loss to record
  rather than a migration. Recommend T004 confirm or add one.
- **Decision (Q16)**: accept, and treat today's single-record answer as a
  coincidence, not a baseline. `toolu-01` occurs in two sessions in the corpus
  precisely because FR-004 says a bare tool-use ID is not globally unique; which
  of `ev-c-06` / `ev-c-07` comes back is the resolver's choice, and the contract
  requires the chosen session be stated rather than the two merged.
- **Decision (Q20)**: accept the intersection. Note the operator-visible
  consequence: if the resolver picks `sess-alpha`, the result is empty, because
  that session's half carries no `follow-up` text. An empty intersection must
  read as "no match", distinct from "query failed" (Spec 017 FR-012, Spec 018
  FR-005) — otherwise this entry is where the migration teaches operators to
  distrust an absence.

### At risk — recommend preserving, and verifying rather than assuming

Nothing forces these to change, which is exactly why they are listed: each is a
behaviour the current implementation produces as a side effect of quoting, and
a from-scratch parser will drop it unless told not to.

| Entry | Query | Behaviour to preserve |
| --- | --- | --- |
| Q18 | `nmap` | The last term is prefix-matched (`"nmap"*`), so a partial word finds `nmapscan`. This is how type-ahead works today. |
| Q03 | `https://example.com/a` | The whole token stays one phrase. Splitting at the first colon would leave `https` as a bad field and `//example.com/a` as the term. |
| Q19 | `10.10.10.11` | Dots are tokenised away inside one phrase, not handed to FTS5 raw. |
| Q22 | `-sV` | A leading hyphen is an FTS5 operator and survives only because the term is quoted. |
| Q21 | `SESSION:SESS-ALPHA` | Today this means exactly what Q15 means — FTS folds case. |

- **Decision (Q18)**: preserve. Search debounces at 300 ms and queries on every
  keystroke; dropping the trailing prefix makes every partially typed word
  report "no results" until it is finished. It is the highest-traffic query
  shape in the corpus and the one whose regression would look least like a bug.
  If Spec 017's parse cannot carry it, that is a deliberate change to record
  here — not something to discover from the corpus going red.
- **Decision (Q03, Q19, Q22)**: preserve, and state the rule in the contract
  rather than leaving it to the implementation: a free-text term is the whole
  whitespace-delimited token, quoted as one phrase. Spec 017 SC-006 already
  commits to this for URLs; Q19 and Q22 are the same rule for any punctuated
  term, and terminal evidence is mostly punctuated terms.
- **Decision (Q21)**: fold case when recognising a field prefix, so `SESSION:`
  and `session:` are both conditions. Preserve the condition value's case and
  exact-match semantics, so `SESS-ALPHA` does not silently substitute for the
  stored `sess-alpha`; the parse display makes that interpretation visible.

### Corpus correction discovered during migration

The initial fixture put `sess-alpha` / `sess-beta` only in the envelope's
`session_id` column. That column is RedLog's Capture Session and Spec 017
explicitly forbids resolving `session:` against it. The migrated corpus now
also records `data.session_id` on the two agent tool rows, which is the Agent
Session that the real producer supplies. The Capture Session values remain in
place to prove the resolver does not use them.

### Unchanged — verified, no decision needed

Q01, Q02, Q04 (plain terms, multi-term AND, and no-match) carry no colon and no
field prefix. Q05–Q13 vary the shared filter — target, type, time, in-scope,
and combinations — which is Spec 007's `EventFilter` and is untouched by Spec
017; the contract is evaluated beneath it. Q11 and Q09 additionally hold the
chained/logged tier split, which `searchEventsPage` applies per arm before its
limit and the migration must not collapse.

### What the corpus could not capture

- **Query failure.** `searchEventsPage` wraps its execution in `catch { return
  { items: [], hasMore: false, nextCursor: null } }`, so a failed query and a
  query that matched nothing are the same empty page. Probing `"`, `a"b`,
  `NEAR(`, `foo OR bar` and `foo*` against the corpus dataset produced an empty
  page from every one and an exception from none — the blanket quoting makes
  the catch nearly unreachable. So the corpus can record only that both states
  are `[]` today; it cannot witness the difference the migration must introduce
  (FR-005). T007 needs its own test, not a corpus entry.
- **Cast (transcript recording) hits.** `SearchPanel` runs `searchCasts`
  separately and suppresses it whenever any shared-filter condition is active.
  That path does not go through `searchEventsPage`, returns cast hits rather
  than events, and is explicitly out of scope for this feature — the corpus
  covers the event set only.
- **Not-yet-indexed.** `castIndexStatus().pending` is a renderer-side state
  over the cast index, with no event-set consequence to freeze.
- **Pagination.** Every entry is captured uncapped at `limit: 100` against a
  14-record dataset, so no entry crosses a page boundary. Cursor behaviour is
  already covered by `test/search-pagination.test.ts`; duplicating it here
  would make the corpus sensitive to changes the migration is allowed to make.

### How this table is used

When T004 migrates an entry, its expectation in `search-query-corpus.json`
changes in the same commit as the code, and the commit cites the decision
above. An expectation that changes with no decision behind it is the silent
meaning change this phase exists to prevent.
