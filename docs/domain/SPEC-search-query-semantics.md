# SPEC: Search Query Semantics

> Domain: Investigation / Evidence
> Invariant: One query text means one thing wherever it is typed. Its conditions, its text and the shared filter are all evaluated at the persistence layer, across both event tiers, before any limit.
> Status: Implemented — Search, the Transcript, the ⌘K palette and `/api/events/search` evaluate through one contract (Specs 017, 018, 026).

Terms such as Event Query, Agent Session, Query Intersection and the Chained /
Logged tiers are defined in [glossary.md](glossary.md). This document states the
rules those terms obey.

## Pipeline

```
typed text
  → parseQuery()                         src/core/query/contract.ts
      conditions    event:  session:  transcript:  tool:
      text          every token not read as a condition
      tokens        how each token was read, for display
  → events:runQuery                      main attaches the active scope policy
  → executeEventQuery()                  src/core/db/event-queries.ts
      per tier (events, events_logged), AND-ed inside that tier's own SQL:
        text           FTS MATCH on stored content, or a hit in the HTTP body index
        conditions     exact match on stored fields
        shared filter  agent type, time range, target, scope, personal traffic
        cursor         keyset position
      ORDER BY timestamp DESC, rowid DESC  LIMIT n+1
  → UNION ALL  ORDER BY timestamp DESC, _row DESC, tier_rank DESC  LIMIT n+1
  → QueryPage { items, hasMore, nextCursor }      src/core/query-page.ts
```

## Parsing

1. Input splits on whitespace. A double-quoted run is one token and may contain
   spaces.
2. A token whose text before its first colon is a recognised field — `event`,
   `session`, `transcript`, `tool`, in any case — is a condition. The value is
   everything after that first colon and may itself contain colons.
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
   tool-use ID. An ID quoted inside unrelated output does not satisfy a
   condition.
3. **A tool-use ID is unique only within a session.** Without a `session:`
   condition, `tool:` resolves to the newest session that contains the ID. The
   chosen session and the sessions not chosen travel back with the page as
   `toolSession`. Occurrences from different sessions are never merged, and the
   choice is never silent.
4. **Text.** Each whitespace-separated term is matched as an FTS phrase, so
   `10.0.0.5`, `-sV` and `/etc/passwd` match as typed. The last term is
   prefix-matched, so a half-typed word still matches. Terms combine with AND
   and need not be adjacent — including the words inside one quoted run. Text
   matches stored event content, or an indexed HTTP body the event references.
   Event, HTTP body and recording search share this translation
   (`src/core/query/fts-match.ts`), so every typed input is valid MATCH syntax.
5. **Nothing asked, nothing answered.** A query with neither text nor
   conditions — including a parsed `""` — returns an empty page, never an
   unfiltered read. A conditions-only query is valid.
6. **Predicates before limits.** Every predicate is applied inside each tier's
   SQL, before that tier's limit. A filter that works only over loaded rows
   (the Transcript's kind chips, HTTP History's local controls) must say so
   where it is offered.
7. **Both tiers, always.** Chained and logged events are both searched. The
   logged tier has no transcript UUID column, so the value is read from the
   event data there.
8. **Time range** is inclusive on `timestamp`: `since ≤ timestamp ≤ before`.
9. **Scope and personal traffic.** `inScopeOnly` keeps events whose target is in
   scope, plus untargeted events. `hidePersonal` drops events whose target is a
   personal domain, keeping untargeted events. The main process attaches the
   active project's scope policy: a filter sent by the renderer can narrow the
   result, never widen it.
10. **Order and paging.** Canonical order is `timestamp DESC, _row DESC,
    tier_rank DESC` — chained before logged on an exact tie. The cursor is the
    last row's `(timestamp, rowid, tier)`, versioned and opaque, and is pushed
    into each tier so a per-tier limit cannot drop rows. `hasMore` comes from
    fetching one row past the limit.
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
    `cursor`.

## Coverage

- Text covers stored event content and indexed HTTP bodies. Output held only in
  a terminal recording is outside it, so an unmatched term is not proof that the
  output never contained it. The Transcript discloses this where the query is
  typed.
- Terminal recordings are searched separately by `searchCasts`
  (`src/core/cast-index.ts`): its own index, no time range, its own
  not-yet-indexed state. Search shows cast hits beside event results; they are
  never part of a `QueryPage`.
- The ⌘K palette and `/api/events/search` search the whole project. They apply
  no shared filter.

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
