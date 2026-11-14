# SPEC: Search Query Semantics

> Domain: Investigation / Evidence
> Invariant: One query text means one thing wherever it is typed. Its conditions, its text and the shared filter are all evaluated at the persistence layer, across both event tiers, before any limit.
> Status: Implemented — Search, the Transcript, the Timeline, the ⌘K palette and `/api/events/search` evaluate through one contract (Specs 017, 018, 026, 038).

Terms such as Event Query, Agent Session, Query Intersection and the Chained /
Logged tiers are defined in [glossary.md](glossary.md). This document states the
rules those terms obey.

## Pipeline

```
typed text
  → parseQuery()                         src/core/query/contract.ts
      conditions    event:  session:  transcript:  tool:  operator:  provider:  source:
      text          every token not read as a condition
      tokens        how each token was read, for display
  → events:runQuery                      main attaches the active scope policy
  → executeEventQuery()                  src/core/db/event-queries.ts
      countEvents() and matchEventIds() build the same per-tier WHERE
      per tier (events, events_logged), AND-ed inside that tier's own SQL:
        text           FTS MATCH on stored Event content, or verified saved-source bytes
        conditions     exact match on stored fields
        shared filter  agent type, time range, target, scope, personal traffic, tier
        cursor         keyset position
      ORDER BY timestamp DESC, rowid DESC  LIMIT n+1
  → UNION ALL  ORDER BY timestamp DESC, _row DESC, tier_rank DESC  LIMIT n+1
  → QueryPage { items, hasMore, nextCursor }      src/core/query-page.ts
```

## Parsing

1. Input splits on whitespace. A double-quoted run is one token and may contain
   spaces.
2. A token whose text before its first colon is a recognised field — `event`,
   `session`, `transcript`, `tool`, `operator`, `provider`, `source`, in any case — is a condition.
   The value is everything after that first colon and may itself contain
   colons.
3. Any other token is text, so a pasted URL or `host:port` matches as typed.
4. A quoted token is always text, even when it looks like a condition.
   `session:S1` finds the records that have that agent session;
   `"session:S1"` finds the records whose text quotes it.
5. Two inputs are parse failures and are never demoted to text: a recognised
   field with no value (`session:`) and an unterminated quote. No query runs;
   the surface reports the input as unparsable, distinct from no match.
6. Every surface shows which tokens were read as conditions and which as text.

## Evaluation

1. **Intersection.** Every condition, the text and the shared filter must all
   hold.
2. **Conditions match stored fields, never text.** `event:` is the event ID;
   `session:` is the agent session recorded in the event data, not RedLog's
   capture session; `transcript:` is the transcript UUID; `tool:` is the
   tool-use ID; `operator:` is the recorded operator ID (`operator_id`), never
   a display name. An ID quoted inside unrelated output does not satisfy a
   condition.
   `provider:` is the exact saved AI provider. `source:` is the validated opaque
   source-Session tuple issued by the Session catalog: project, capture binding,
   event source, provider/shell and producer Session. It is a reference, not an
   authorization token. Unknown/malformed tuples fail explicitly; they never
   become text or an unfiltered read. Session choices use the same frozen dataset
   for reading and whole-Session export. Explicit refresh advances that boundary.
3. **A tool-use ID is unique only within a session.** Without a `session:`
   condition, `tool:` resolves to the newest session that contains the ID. The
   chosen session and the sessions not chosen travel back with the page as
   `toolSession`. Occurrences from different sessions are never merged, and the
   choice is never silent.
4. **Text.** Each whitespace-separated term is matched as an FTS phrase, so
   `10.0.0.5`, `-sV` and `/etc/passwd` match as typed. The last term is
   prefix-matched, so a half-typed word still matches. Terms combine with AND
   and need not be adjacent — including the words inside one quoted run. An
   Event matches when every term is found somewhere in it: in its stored
   content (the events index) or in any indexed saved content it references
   (body, text artifact, or a confirmed AI raw prefix; see Coverage) — each
   term on its own. So a body word and a URL, host or header word match
   together, and two words in two different bodies of one Event match (before
   2026-11-14 every term had to be in one document of one index). One term is
   still matched within one document: the tokens of `10.0.0.5` must be
   adjacent in the same body or in the Event's own data.
   **An HTTP exchange is one unit** (decision 2026-11-15 §1 item 5). Its rows
   are the ones the Activity page shows as one row: `scanner` rows of the
   subtypes `activityKey` groups (`http_request_start`, `http_response`,
   `http_response_chunk`, `http_error`, `ws_message`, `websocket_end`) with
   the same project, capture session, `data.source` and `flow_id`
   (`httpExchangeSql` in `activity-projection.ts`, pinned to `activityKey`).
   A row of an exchange matches when every term is found somewhere in the
   exchange — any of its rows, or any body of them — and the row itself holds
   at least one term. So a word in the request body and a word in the response
   body find both rows; a row of the exchange holding no term is not returned,
   and is context on the Activity page. Two flows of one host, one `flow_id`
   in two capture sessions or two sources, and TCP messages (each its own
   Activity row) are not one exchange. With one term the rule is the
   per-Event rule. Commands, tool calls and every other Event are their own
   unit, as before.
   A term counts from a row of the exchange inside the query's dataset
   (snapshot), never from one past it: a request inside the snapshot whose
   response arrived after it matches by what is inside. Conditions and the
   shared filter decide which rows are answered, not where a term may be
   found: under a time range that keeps the request and cuts off its
   response, the request still matches by a word in that response. The
   cursor and `matchEventIds`'s `ids` restrict the rows answered the same
   way, so a page, its count and a match over the same rows agree.
   A term in which the tokenizer finds no token (`|`, `&&`, `>`, `--`, `:`
   on their own; every index uses `unicode61 remove_diacritics 2` with no
   token characters added, and SQLite itself is asked outside ASCII) would
   match nothing on its own, so it is left out: `cat /etc/passwd | grep root`
   matches as `cat /etc/passwd grep root`, and punctuation inside a term
   (`root&&echo`, `--flag`, `a|b`) is read as the words it separates. A query
   made only of such terms keeps them and matches nothing, as it did before
   terms were matched one by one. Only the last term typed is prefix-matched;
   when that is the one left out, none is, so after `cat /etc/passwd |` the
   word `/etc/passwd` is matched whole.
   Event, HTTP body and recording search share this translation
   (`src/core/query/fts-match.ts`): every term is quoted as a phrase, so no
   typed input is malformed MATCH syntax.
   Event indexes tokenize decoded JSON values and property names, not JSON
   serialization escapes. A word after a newline or tab must be searchable as
   that word, without an invented `n` or `t` prefix. Rebuilding this derived
   index must not change event data, hashes or source files.
5. **Nothing asked, nothing answered.** A query with neither text nor
   conditions — including a parsed `""` — returns an empty page, never an
   unfiltered read. A conditions-only query is valid.
6. **Predicates before limits.** Every predicate is applied inside each tier's
   SQL, before that tier's limit. A filter that works only over loaded rows
   (the Transcript's kind chips, HTTP History's local controls) must say so
   where it is offered.
7. **Both tiers, unless the filter asks for chained only.** Chained and logged
   events are both searched unless the shared filter sets the tier (rule 9).
   The logged tier has no transcript UUID column, so the value is read from
   the event data there.
8. **Time range** is inclusive on `timestamp`: `since ≤ timestamp ≤ before`.
9. **Scope and personal traffic.** `inScopeOnly` keeps events whose target is in
   scope, plus untargeted events. `hidePersonal` drops events whose target is a
   personal domain, keeping untargeted events. The main process attaches the
   active project's scope policy: a filter sent by the renderer can narrow the
   result, never widen it. `tier: 'chained'` ("Chained only") excludes the
   logged tier: its arm still runs, under a predicate that admits nothing, so
   a count over it is an honest 0. Every event view applies it, as it applies
   the other shared-filter conditions.
10. **Order and paging.** Canonical order is `timestamp DESC, _row DESC,
    tier_rank DESC` — chained before logged on an exact tie. The cursor is the
    last row's `(timestamp, rowid, tier)`, versioned and opaque, and is pushed
    into each tier so a per-tier limit cannot drop rows. `hasMore` comes from
    fetching one row past the limit.
    Text-search cursors also pin the dataset, resolved query and saved-source
    coverage revision. Counts using that cursor share the boundary. New Events
    outside it do not enter later pages; changed or removed sources inside it
    require an explicit refresh rather than silently changing the answer.
11. **Failure is not absence.** Evaluation does not catch errors, and neither
    does recording search. A failed query reaches the surface as a failure (UI:
    failure with retry; API: 500), distinct from no match and from unparsable
    (API: 400 with the reason and token). The API also refuses, with 400, a
    cursor it cannot read, rather than serving the first page again.
12. **Tool pairs.** The counterparts of a page's unpaired tool calls and results
    are fetched in one lookup, however many there are. A counterpart that does
    not exist is shown as unpaired, never as a whole exchange.
13. **Every surface says when it shows a subset.** Search and the Transcript
    page with `hasMore`; the palette lists the newest 40 and says when there are
    more; `/api/events/search` returns `hasMore` and `nextCursor` and takes
    `cursor`. The Timeline pages with `hasMore`, states "N of M" (M from
    `countEvents`), and states how many text matches lie past what it has
    drawn.
14. **Counting.** `countEvents` counts with the same predicates as the page it
    describes, cursor included, so a total or an "N earlier" and the pages
    cannot disagree. A cursor it cannot read is refused, never read as "from
    the start".
15. **Matching given rows.** `matchEventIds` evaluates the same predicates
    restricted to given IDs, at most 1,000 per call: more are refused, never
    truncated. It serves a surface that must dim or admit rows it already
    holds, such as the Timeline's live rows and its filter box. Scope and
    personal traffic are decided over those rows' targets only, which gives
    the same answer for those rows.

### The exchange unit, per surface

| Surface | What a multi-word query returns |
|---|---|
| Search: Activity | The exchange once. 命中 counts its rows that hold a term; 相關 the rest. |
| Search: raw events (原始事件), Transcript, ⌘K palette, `/api/events/search` | Each row of a matching exchange that holds a term, as its own Event; `countEvents`, `hasMore` and the cursor count the same rows. |
| Timeline (page, `countEvents`, `matchEventIds`) | The same rows as raw events; a row is dimmed or admitted by the same rule. |
| Export, "current results" | The same rows, under the export's snapshot. HAR of an event selection carries every flow one of them belongs to, as before. |
| HTTP page text box | Unchanged: a substring of the flow's request URL, host or response content type. It is per flow already and is not this query language. |
| Terminal recordings, AI raw transcripts | Unchanged: their own documents (Coverage). |

Commands are not joined. A command's `command_start` and `command_end` both
carry the command text, so `id uid=0` finds the end row whose output holds
`uid=0`. Output that arrives as `command_output` chunks — a background job's
late output, or output streamed while a long command runs (`output_streamed`
on the end row, which then holds no stdout) — carries the `command_id` and not
the command text: `nmap 22/tcp`, where `22/tcp` is only in such a chunk, finds
nothing. Joining a command's rows was not decided (2026-11-15).

## Coverage

- Text covers stored Event content and verified saved body/artifact bytes.
  Artifacts use the registered project copy and full size/hash, never the
  original import path. UTF-8 text is searchable; binary/images are unsupported
  for content search. Small inline base64 uses the Reader's decoded bytes;
  encoded data over 16 KiB requires a saved reference and reports limited.
- Request, response, WebSocket and TCP bodies, inline or saved, are also
  indexed with JSON `\uXXXX` escapes decoded (surrogate pairs combined),
  whatever their content type: a term matches a body whose escaped text
  decodes to it, by rule 4. The body is never parsed for this, and text that
  only shows an escape literally matches the character it names.
- Bytes that are not valid UTF-8 are indexed as text only when the body's
  media type is textual (the capture addon's TEXT_CONTENT_TYPES: json, html,
  text, xml, javascript, css, csv, yaml, svg, form data) and they decode,
  without a NUL, in the charset its content type declares (UTF-8 when none).
  Anything else stays binary. A body cut short at capture
  (`REDLOG_MAX_BODY`), or whose declared charset stops decoding at its end, is
  indexed as far as it goes and counted `partial`, not covered — when the
  body index holds it. So is a body that needs more than 2,048 index
  documents of one kind (about 2 GiB; at the default cap a body needs at
  most 12): only with the cap raised or lifted, or for a transcript or an
  artifact that arrives through ingest, which no cap bounds (an artifact
  added from the app is capped at 200 MiB by default). The read stops at
  the first kind that is full, so the other kind, saved or decoded, is
  indexed only that far too. A body of at most 4,096 characters stays inline on
  the event, and an inline text body with no `\uXXXX` escape has no body-index
  entry: the events index searches it, and coverage does not count it. So
  with `REDLOG_MAX_BODY` at 4096 or less, a text body cut short at capture
  without an escape in it is searched as far as it goes and is not reported
  as partial.
- Known limits: under Node 24.12 (ICU 77) an invalid Big5 body is decoded
  with its invalid bytes dropped and counted indexed; the app's runtime
  (Electron 45, ICU 78) rejects it, and it stays binary. ISO-2022-JP and
  UTF-7 bodies are 7-bit, so they are saved as text and indexed in their
  encoded form: their words are not found, and coverage still says covered.
- The decoded text shares its saved body's status, pruning and coverage.
- AI raw search admits only the latest `transcript_snapshot` prefix per saved
  project file within the query dataset, with matching cumulative size/hash.
  Opening an older snapshot still reads that confirmed prefix. Capture-start
  without a snapshot and extra unconfirmed bytes are pending; no vendor path is
  scanned. Raw files have file precision, not per-message attribution. Tool,
  transcript, Event, operator, source, target, time, scope and tier
  conditions exclude raw full-text matches with unsupported coverage. Stored
  Event matches continue through the canonical predicates. Hidden non-work
  traffic (`hidePersonal`, on by default) does not exclude them, on or off,
  and coverage lists it neither as applied to them nor as unsupported
  (decision 2026-11-15 §3, as for recordings): non-work text a conversation
  holds can show.
- Each query reports source classes, representation, revision, byte coverage,
  filter applicability and pending/partial/unsupported/failed/unavailable
  states. Missing or changed sources lose their derived full text. Output held only in
  a terminal recording is outside it, so an unmatched term is not proof that the
  output never contained it. The Transcript discloses this where the query is
  typed.
- Terminal recordings are searched separately by `searchCasts`
  (`src/core/cast-index.ts`): its own index, no time range, its own
  not-yet-indexed state. Complete newline-terminated frames form a confirmed
  prefix, with hash and physical-part byte ranges attached to each hit. Opening
  verifies that version; same-size rewrites invalidate old hits. Extra bytes
  remain partial/pending, invalid frames fail, and oversized files/frames are
  unsupported. Retention clears full text and retains only unavailable metadata.
  Search excludes recordings when Event conditions/filters cannot be applied,
  and discloses its 50-hit subset. Cast status carries its own revision/byte
  coverage; cast hits are never part of an Event `QueryPage` or its count.
- The ⌘K palette and `/api/events/search` search the whole project. They apply
  no shared filter.
- The Timeline joined the contract in Spec 038. Its `/` box is a query: the
  shared filter removes events, and the box dims those that do not match.

### The Timeline's empty box

The Timeline's filter box with no text is a browse, not a query: it shows every
event the shared filter admits. Rule 5 still holds for every query; the
Timeline sends no query while its text is empty.

### Housekeeping

`excludeHousekeeping` drops RedLog's own plumbing rows (`HOUSEKEEPING_SQL` in
`event-queries.ts`, the one rule). The Timeline sets it on its page, count,
match and nearest-match requests, and on live admission. Search does not.

### Find in content

The Reader's Find (`findEventContent`, `src/core/content-find.ts`) searches one
saved field. A needle matches where the saved bytes hold it as written, or — in
a request, response, WebSocket or TCP body, the fields whose index entry is
decoded — where the text holds it once its `\uXXXX` escapes are read as the
characters they name. The match is a range of the saved bytes, so 王小明 marks
the 18 bytes `\u738b\u5c0f\u660e`; what is shown, copied and saved is unchanged.

- The escapes are the body index's (Coverage), except one naming a control
  character (below U+0020), which matches only as written. `\n`, `\t`, `\"`,
  `\\` and `\/` are never read. Case is exact.
- A match is all as written or all read: a needle never mixes typed escape
  text with decoded characters. At one offset the shorter range wins.
- Command output, AI transcripts and every other field are matched as written,
  as their search is: `\u0041` in a shell transcript does not match `A`.
- A body that is not valid UTF-8 is binary to the Reader, and Find is not
  offered: search reaches its words through the declared charset, the Reader
  does not.
- A call scans at most 1 MiB plus the needle's longest escaped form (6 bytes a
  character, 12 above U+FFFF). Its cursor is bound to this matching and carries
  where the scan resumes, at most 11 bytes back, because what a backslash
  starts depends on the whole run of backslashes before it.

## Scenarios

### 1. A time range reaches past the newest matches

```
Given  200 events matching "nmap" in [T+1000, T+1200], one at T
When   "nmap"  filter { since: T-100, before: T+100 }  limit 200
Then   exactly the event at T
```

### 2. Both tiers honour the time range

```
Given  chained shell event matching "curl" at 1000
       logged scanner event matching "curl" at 2000
When   "curl"  filter { since: 0, before: 1500 }
Then   the chained event only
```

### 3. Agent type, time range and text compose

```
Given  shell and scanner events matching "target" at 500
       shell event matching "target" at 2000
When   "target"  filter { agentType: "shell", since: 0, before: 1000 }
Then   the shell event at 500 only
```

### 4. Ties order deterministically

```
Given  A, B, C at one timestamp, all matching
Then   order is _row DESC, then tier_rank DESC
       following the cursor to hasMore = false returns each exactly once
```

### 5. A condition is not a text match

```
Given  event E with agent session S1
       event F from another session whose output contains "session:S1"
When   session:S1      Then  E, not F
When   "session:S1"    Then  records whose text contains session:S1, such as F
```

### 6. A tool-use ID present in two sessions

```
Given  tool-use ID U in session S1 (older) and S2 (newer)
When   tool:U              Then  S2's records; toolSession = { S2, others: [S1] }
When   tool:U session:S1   Then  S1's records; no toolSession
```

### 7. Half-typed and empty input

```
session:     →  unparsable (empty-condition-value); no query runs
"abc         →  unparsable (unterminated-quote); no query runs
""           →  parses to empty text → empty page, not the whole dataset
```

### 8. Cast search stays separate

```
searchCasts accepts no time range. Its hits are recordings, not events,
and never enter a QueryPage. A failing recording index is a failure,
never an empty list of hits.
```

### 9. A page says whether it is the answer

```
Given  3 events matching "pagingterm"
When   /api/events/search?q=pagingterm&limit=2
Then   2 events, hasMore = true, nextCursor set
When   the same with cursor = nextCursor
Then   the third event, hasMore = false
When   cursor = "not-a-cursor"
Then   400, not the first page again
```

## Property

```
For every query Q and shared-filter dataset D:
  event e satisfies every condition of Q and matches Q's text
    ⇔ e appears in the pages of executeEventQuery(Q, D) followed until hasMore = false
  and no event appears on more than one page.
```

## History

- 2026-09-19 (`f889365`): the time range moved into SQL, before LIMIT — the P1
  this document originally described.
- Spec 008: paged full-text Search. Spec 013: HTTP body search.
- Spec 017: the query language, Transcript first. Spec 018: Search on the
  contract. Spec 026: the palette and the local API; `searchEvents` and
  `searchEventsPage` removed.
- 2026-09-23: one FTS translation for all three indexes; recording search
  stopped swallowing failures; the palette and the local API say when a result
  is a subset.
- Spec 038: the Timeline on the contract and the shared filter. `operator:`
  joined the conditions, the tier joined the shared filter, and
  `countEvents` / `matchEventIds` joined the readers.
- 2026-10-28, Spec 064 T048: verified saved text artifacts and AI prefixes,
  per-source coverage, pinned text-query cursors and versioned physical cast hits.
- 2026-11-15: a multi-word query matches across one HTTP exchange (decision
  2026-11-15 §1 item 5); before, every term had to be in one Event.
- 2026-11-15: the Reader's Find reads `\uXXXX` escapes in bodies, as the body
  index does, and reports the saved range it matched.
- 2026-11-15: the body index addresses a document by a rowid derived from its
  ref and keeps no copy of the text (decision 2026-11-14 §6); a body that
  needs more documents of one kind than a ref's rowids hold is partial.
