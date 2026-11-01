# Performance audit — 2026-11

Measured: 2026-11-01, on `main` at `07a32ee4` (v0.18.6).
Scope: where RedLog spends time and memory — startup, the Timeline on a large
project, ingest, export, the renderer bundle, and long-running memory.
Nothing in this document changes product code. Every number below comes from a
script in [`docs/perf-audit-2026-11/`](perf-audit-2026-11/) and can be re-run.

Rule for reading the fixes: none of them drops, samples, truncates or summarises
evidence. Where a fix moves work (off the main thread, out of the hot path,
into a batch), the same rows, bytes and hashes still land.

## Environment

| | |
|---|---|
| Machine | Lenovo laptop, Intel i7-1265U (2P + 8E cores, 12 threads), 32 GB RAM, KIOXIA NVMe SSD |
| OS | Windows 11 Pro 26300, Microsoft Defender real-time protection **on** (the default) |
| Runtime | Node 22.23.1 for the core benches; Electron 44.4.1 for the app; better-sqlite3 13.0.3 |
| Build | `npm run build` (electron-vite production build, `out/`), launched with the repo's Electron binary |
| Load | Other Claude sessions were running on the box (≈4 GB RAM free). Every number is from one box, one day: treat ratios and slopes as the finding, absolute milliseconds as indicative |

Not measured on a packaged installer: packaging from a worktree ships a broken
`app.asar` (see the worktree note in the repo memory), and `out/` runs the same
JavaScript. Not measured on macOS or Linux; the Defender-specific costs in §3
are Windows-only and are labelled as such.

## Method

Scripts, all in [`docs/perf-audit-2026-11/`](perf-audit-2026-11/):

| Script | What it does |
|---|---|
| `run.mjs` | Bundles a `.ts` bench with esbuild and runs it under Node in a throwaway `HOME`; `--prof` adds `--cpu-prof`, `--heap` adds `--heap-prof` |
| `workload.ts` | The synthetic engagement: one *cycle* = one operator command and what follows it — shell start/end (1.5 KB stdout), 3 HTTP flows (6 KB HTML responses), an AI tool call pair, a DNS query; a marker every 50 cycles. 11 rows per cycle, shaped like the real producers' payloads |
| `bench-ingest.ts` | `inproc` (ingest() directly), `http` (POST /api/events, keep-alive, N in flight), `spool` (hook spool files → `replaySpoolDirectory`, as project open does), `stages` (each separable stage timed alone) |
| `seed-project.ts` | Fills a project the app created with ~200k rows through `insertEvent()` (hashed, signed, tiered), spread over 5 days |
| `bench-query.ts` | The Timeline's own query shapes against the seeded DB, main side only |
| `measure-app.mjs` | Playwright-driven `out/` build: `startup`, `project` (open, Timeline, scroll, filter, search, memory, every IPC handler timed, main process CPU-profiled), `export` (per format, fresh launch, Windows peak working set) |
| `profile-summary.mjs` | `.cpuprofile` → self time by function and file, inclusive time, and `--callers` stacks, mapped back to `src/` through the bench's source map |
| `bundle-attribution.mjs` | Renderer chunks → bytes per npm package / `src/` directory, from source maps |

Commands are given with each section. No product code was changed; the one
what-if build (§5, minified renderer) used a temporary config file that was
deleted afterwards.

## Ranked hotspots

Ranked by what an operator waits for on a project of ~200k events, the size
a multi-week engagement reaches. "Main thread" means Electron's main process:
while it is busy, HTTP ingest, every IPC call and the window all wait.

| # | Hotspot | Measured | Fix (no evidence dropped) | Step |
|---:|---|---|---|---|
| 1 | **Capture health probes** scan whole `agent_type` buckets for sources that never produced a row | 3.0 s warm / 6.5 s cold per computation; **79% of main-thread time while a project opened (29.8 s to the first view)**; recomputed on every poll during a recording (cache cleared by every event) | Keep a last-seen-per-source row updated in the ingest transaction, so each probe is one indexed read; until then, compute off the main thread and do not invalidate on every event | standalone; the last-seen table belongs in R2's stage list |
| 2 | **Export** materialises the project several times, prepares a statement per event, and runs synchronously on main | ~198k events: **92–98 s on the main thread per export (NDJSON, JSON, bundle), peak working set 2.7–4.6 GB** for a 283–377 MiB file; HAR 38 s / 2.4 GB; `getSanitizedFields` 33 s inclusive (a `prepare` per call, 3 calls per event) | Read sanitized fields in one query per page; redact each event once and reuse it between plan and write; stream rows (`iterate()`) to the file from a worker/utility process | standalone |
| 3 | **Counts and search** — `HOUSEKEEPING_SQL`'s `json_extract` turns every count into a full row scan; search adds four whole-table `COUNT(*)`s | "N of M" 1.2 s warm / 9.8 s cold; filtered counts 0.7–0.9 s; text search 1.8–3.4 s; live admission `matchEventIds` **550 ms per live batch** | Persist the housekeeping verdict as an indexed column written at insert; cache coverage counts by snapshot version; admit live rows by evaluating the filter on the batch in memory | R4 |
| 4 | **HTTP body index on the request path** — FTS `DELETE` on `UNINDEXED` columns scans the whole index; the sidecar is reopened right after it is written | 48% of ingest time; p95 grows linearly (50 → 187 ms over 22k events); full mix 33 ev/s vs 233 ev/s without HTTP; reopen-after-write 3.6 ms (Windows/Defender) | Skip the delete for a new event (or look it up through an indexed side table); verify from the bytes already hashed in memory and write once; move indexing to a queued stage after the row commits | R2 |
| 5 | **Per-row fixed costs in insert** — `db.prepare()` per insert, `os.hostname()` per row, one transaction per event | prepare 96 µs of a 180 µs insert; hostname 200–316 µs; batching 100 rows: 56 µs/row | Prepare once per connection; read the hostname once; group rows that arrive together into one transaction | R2 |
| 6 | **Synchronous spool drain at project open** | 4,000 spool files: 16.8 s of main thread, RSS 235 MiB (statements held until the loop yields, §3.3 d) | Drain in bounded slices with a yield between them (the same rows, the same order); skip deferred files when choosing the slice so they cannot starve the interval drain | R2 |
| 7 | **Project picker sizes every project by walking its files** | 260–386 ms for 6,003 files; ≈2.5 s estimated for a full-fidelity 200k project, every picker visit | Read sizes asynchronously after the list renders, or keep a size recorded at close | standalone |
| 8 | **Timeline scroll frame time** | p50 29 ms, p95 106 ms, 51 of 120 frames > 50 ms, 2.6 s of long tasks per 120 frames | Profile the memo chain over the loaded set (`Timeline.tsx:698` already measured ~65 ms per pass at 131k); recompute per visible window | R5–R8 |
| 9 | **Renderer bundle** — unminified, both locales eager, js-yaml and dagre in `main` | 2.36 MB parsed before the picker; minify −44% bytes, **no measurable startup gain** | Minify; load one locale; move `DEFAULT_CONFIG` out of `core/config.ts`; lazy-load the causal graph. Size and hygiene, not speed | standalone |
| — | Long-running memory | Bounded: SQLite page cache ≤ ~31 MiB, flat after (#485); streams flat over 120 min (#484) | Nothing new beyond #485 | — |

Items 1–3 are each a multi-second freeze of the main thread on a large
project, and item 1 also fires on a timer during recording. Items 4–6 cap
ingest at 30–50 events/s once HTTP traffic is recorded, far below what a
scanner run through the proxy sends. Item 9 is the obvious-looking one, and
the measurements do not support it as a speed fix.

## 1. Startup and project open

```bash
npm run build
node docs/perf-audit-2026-11/measure-app.mjs startup 5
node docs/perf-audit-2026-11/measure-app.mjs create <home> perf-large
PERF_HOME=<home> node docs/perf-audit-2026-11/run.mjs seed-project.ts -- <home>/.redlog/projects/<id> 18000
node docs/perf-audit-2026-11/measure-app.mjs project <home> perf-large <outDir>
```

### 1.1 Cold start to the project picker

Fresh home per run, quiet box (the first set; later sets ran under 100% CPU
from other workloads and were 1.5–2.5× slower across every phase, including
the main-process ones, so they are not used for comparisons):

| Phase | median of 5 (ms) | range |
|---|---:|---:|
| launch → main process created | 54 | 42–67 |
| launch → renderer navigation starts | 731 | 640–986 |
| navigation → DOMContentLoaded | 375 | 327–614 |
| launch → picker listed (first actionable frame) | **1,595** | 1,477–1,993 |

Working set at the picker: main 120 MiB, GPU 127 MiB, renderer 118 MiB,
network service 62 MiB; renderer JS heap 9.5 MiB.

About 0.7 s is Electron and the main process before the window loads, ~0.4 s
is the renderer parsing and running 2.4 MB of script, and ~0.5 s is React's
first render plus the `project:list` round trip. Nothing in it is a hotspot on
an empty home; the costs below arrive with data.

`project:list` sizes every project by walking every file in it
(`project-manager.ts dirSize`, synchronous `readdirSync` + `statSync`). On a
project with 6,003 files (2,000 cycles of full-fidelity ingest, 157 MiB):
**259–386 ms per call**, ≈45 µs per file. A 200k-event project with its HTTP
bodies is ≈55,000 files, ≈2.5 s of main thread on every picker visit.

### 1.2 Opening a large project

Seeded project: 198,360 rows (90,366 chained, 108,000 logged) over 5 days,
`timeline.db` 598 MB (bodies excluded, see `seed-project.ts`).

| Step | ms |
|---|---:|
| launch → picker listed | 4,013 |
| click the project → `view-root` mounted | **29,832** |
| main working set, picker → after open | 123 → 176 MiB |

Main-process CPU profile across the open (35.4 s sampled), inclusive:

| Function | ms | share |
|---|---:|---:|
| `getCaptureHealth` → `computeCaptureHealth` | 28,101 | 79% |
| ↳ `lastEventFor` (self) | 25,089 | 71% |
| ↳ `lastShellNameFor` | 2,713 | 8% |
| `aggregateTargets` (FilterBar / Targets) | 4,093 | 12% |
| `startProject` (DB open, migrations, retention, spool, services) | 882 | 2.5% |

The project itself opens in under a second. What the operator waits for is
**capture health**, asked for by the Dashboard, the StatusBar (every 30 s) and
`useCaptureHealth`, computed synchronously on the main thread.

### 1.3 Capture health

```bash
node docs/perf-audit-2026-11/run.mjs bench-query.ts -- <project> 1     # last three lines
node docs/perf-audit-2026-11/probe-capture-health.cjs <project>/timeline.db
```

One computation on the seeded project: **6.5 s cold, 3.0–3.1 s warm**. Its
cache lives 750 ms and every new event clears it (`capture-health.ts:333`,
`:352`), so during a recording every poll recomputes: the StatusBar's 30 s
poll is a 3 s main-thread freeze every 30 s on a project this size, during
which HTTP ingest, IPC and the window all wait.

Each probe asks "when did source X last produce a row" with
`ORDER BY timestamp DESC LIMIT 1`. That stops at the first match — when there
is one. For a source that has never produced a row, it walks the whole
`agent_type` bucket in both tiers and runs `json_extract` on every row:

| Probe | ms | found |
|---|---:|---|
| any shell command | 3 | yes |
| mitmproxy (regular) | 1 | yes |
| connection monitor | 638 | no |
| own shell, no hook installed (`IN ('')`) | 693 | no |
| own shell captured output | 492 | no |
| AI agent row, per catalog kind never used | 547–621 each | no |
| file watcher, heartbeat | 0–1 | no (small buckets) |

The expensive probes are exactly the sources an operator did not use, so the
cost grows with the project and with the size of the plugin catalog, and never
shrinks.

## 2. Timeline on a large project

Same seeded project. Main side alone (`bench-query.ts`, 5 runs, first run and
median):

| Query (Timeline's own shape) | first ms | median ms |
|---|---:|---:|
| `queryEventsPage` first 200 (open) | 24 | 4.3 |
| `loadMore`, 50 pages of 200 (10,000 rows back) | | 8.2 per page |
| `queryEventsPage` type=shell / marker / target / last 1 h | 7–39 | 4.6–11.6 |
| `countEvents` all — the "N of M" total | **9,776** | **1,207** |
| `countEvents` type=shell | 736 | 726 |
| `countEvents` target=10.10.11.5 | 901 | 841 |
| `countEvents` type=marker (360 rows) | 1.6 | 1.0 |
| `executeEventQuery` text "crackmapexec", 50 rows | 2,499 | 1,789 |
| `executeEventQuery` text "Apache" (90k matches) | 2,702 | 3,362 |
| `executeEventQuery` text with no match | 1,876 | 1,876 |
| `countEvents` text "Apache" | 1,151 | 1,169 |
| `matchEventIds` 100 ids, type=shell (live admission) | 528 | 549 |
| `aggregateTargets` | 1,188 | 1,110 |
| `distinctHosts` | 1,395 | 1,893 |
| `distinctAgentTypes` | 276 | 12 |

Pages are fast and stay fast: keyset paging works. Everything that **counts**
or **searches** is slow, and the reason is one predicate.

`HOUSEKEEPING_SQL` (`event-queries.ts:212`), which every Timeline request adds,
reads `json_extract(data, '$.command' | '$.late' | '$.streamed')`. A count that
is otherwise index-only becomes a scan of every row's `data`:

| Count | plan | warm ms |
|---|---|---:|
| `events`, no predicate | covering index | 0–5 |
| `events`, housekeeping | `SCAN e` | 275–290 |
| `events_logged`, housekeeping | `SCAN e` | 229–432 |
| `events` type=shell | covering index | 3–11 |
| `events` type=shell + housekeeping | index + row read | 368–451 |

The first count after open read 598 MB from disk (9.8 s). Text search pays
the same on top of FTS, and adds four whole-table `COUNT(*)`s per query for its
coverage report and snapshot check (`bodySearchCoverage`,
`readActivitySnapshot`): in the profile those two are 9.9 s and 9.3 s of the
35.6 s `executeEventQuery` total.

`matchEventIds` is the live-admission check the Timeline runs on **every live
batch** (`Timeline.tsx:725`). At 550 ms per batch on this project, live tail
stops being live as soon as a filter is set.

In the app (`measure-app.mjs project`, under load; IPC round trip included):

| Step | ms |
|---|---:|
| Timeline opened → first dots drawn | 3,726 |
| range status | "400 of 198,370 events · scroll back for older" |
| `count` all / target filter | 1,530 / 1,110 |
| `runQuery` text "ffuf" / no match | 9,755 / 2,957 |
| `aggregateTargets` / `distinctHosts` | 1,632 / 1,910 |

Horizontal scroll, 120 steps of a quarter viewport, one per animation frame:
frame time p50 **29 ms**, p95 **106 ms**, max 157 ms; 51 of 120 frames over
50 ms; 43 long tasks totalling 2.6 s. The DOM stays small (83 → 272 timeline
nodes, 605 elements in total) — virtualisation holds — so the frame cost is
the memo recomputation over the loaded set that the `BIG_SET` comment in
`Timeline.tsx:698` already measured (~65 ms per pass at 131k events).

Memory: renderer JS heap 11.3 MiB with 400 events loaded; renderer working set
133 → 142 → 206 MiB (open → Timeline → after search); main 176 → 367 MiB
after the counts and searches above.

The UI filter change and the Search view could not be timed through the UI in
this run (the IPC wrapper found no `_invokeHandlers` in Electron 44, and the
Search view's input did not appear within 30 s under load); the bridge
numbers above are the same requests the UI issues.

## 3. Ingest throughput

```bash
node docs/perf-audit-2026-11/run.mjs bench-ingest.ts -- inproc 2000            # full mix
PERF_LANES=shell,agent,dns,marker node docs/perf-audit-2026-11/run.mjs bench-ingest.ts -- inproc 2000
node docs/perf-audit-2026-11/run.mjs bench-ingest.ts -- http 1000 8
PERF_LANES=shell,agent,dns,marker node docs/perf-audit-2026-11/run.mjs bench-ingest.ts -- http 1000 1
node docs/perf-audit-2026-11/run.mjs bench-ingest.ts -- spool 1000
node docs/perf-audit-2026-11/run.mjs bench-ingest.ts -- stages 300
node docs/perf-audit-2026-11/run.mjs bench-ingest.ts --prof -- inproc 150
```

### 3.1 Throughput over time

Full mix, `ingest()` called directly, windows of 2,755 events (250 cycles):

| Events so far | events/s | p50 ms | p95 ms | p99 ms | DB MiB |
|---:|---:|---:|---:|---:|---:|
| 2,755 | 105 | 3.1 | 50 | 65 | 12.7 |
| 5,510 | 73 | 2.4 | 54 | 70 | 21.1 |
| 8,265 | 49 | 3.1 | 76 | 102 | 30.6 |
| 11,020 | 37 | 3.1 | 107 | 127 | 38.7 |
| 13,775 | 30 | 2.9 | 129 | 174 | 47.3 |
| 16,530 | 29 | 2.6 | 138 | 180 | 55.7 |
| 19,285 | 22 | 3.2 | 187 | 255 | 64.0 |
| **all 22,040** | **33** | | | | 72.6 |

The median stays at ~3 ms while p95 climbs linearly with the number of rows
already stored. The slow quarter is the HTTP lane: the same bench without it
(shell, AI, DNS, markers only — 10,040 events) runs at **233 events/s** with p95
6–10 ms and no trend.

Over HTTP, which is how every external producer arrives:

| Run | events/s | p50 ms | p95 ms | p99 ms | RSS MiB |
|---|---:|---:|---:|---:|---:|
| full mix, 8 in flight, first 2,750 | 50 | 153 | 247 | 283 | 151 |
| full mix, 8 in flight, events 5,501–8,250 | 36 | 194 | 463 | 570 | 173 |
| full mix, 8 in flight, all 11,020 | 42 | | | | 171 |
| no HTTP lane, 1 in flight, 5,020 | 242 | 3.2 | 7.4 | 22.6 | 126 |

(The HTTP client runs in the same Node process as the server, so the HTTP
numbers include the client's own cost; the difference to `inproc` is small.)

Spool replay, as project open runs it (`replaySpoolDirectory` → `ingest()`,
synchronous, unbounded on the first drain): **4,000 hook spool files in
16.8 s** (238 files/s). That is 16.8 s of main thread the window cannot paint
or answer IPC in, on the project open that follows an outage.

### 3.2 Where the time goes

CPU profile of the full mix (150 cycles, 1,653 events, DB still small),
inclusive time:

| Stage | ms | share of `ingest` |
|---|---:|---:|
| `ingest` | 12,998 | 100% |
| `linkHttpBodyEvent` (body search index) | 6,237 | 48% |
| ↳ `openSync` of the body file just written, in `withVerifiedFile` | 3,796 | 29% |
| `insertEvent` (both tiers) | 5,098 | 39% |
| ↳ `os.hostname()` (called per row) | 777 | 6% |
| ↳ `db.prepare()` per insert (`wrappers.js prepare`) | 1,016 | 8% |
| `enrich` → `extractBodyToSidecar` (write + `link`) | 1,393 | 11% |
| `signEvent` (Ed25519) | 188 | 1.4% |
| redaction, loot scan, target extraction, credential detection, causes | < 60 together | < 0.5% |

`profile-summary.mjs --callers open` gives the stack:
`openSync < withVerifiedFile < withVerifiedBody < linkHttpBodyEvent < sqliteTransaction`.

Stages timed alone (`stages`, 3,306 payloads, µs per event):

| Stage | µs |
|---|---:|
| `JSON.parse` of the request body | 12.8 |
| `JSON.stringify(data)` for the column | 14.1 |
| `canonicalStringify` | 25.5 |
| canonical + SHA-256 | 34 |
| `signEvent` (Ed25519) | 103 |
| `db.prepare(INSERT)` alone (`events_logged`, with its FTS triggers) | 95.7 |
| prepared INSERT + run, autocommit | 111 |
| same, statement prepared once per call | 180 |
| prepared INSERT, 100 rows per transaction | 56 |
| dedup window SELECT (20 rows) + parse | 46.9 |

So the policy stages (parse, redaction, loot, enrichment) are cheap. The
cost is in four places: the body index, re-preparing statements, a syscall per
row, and Windows file I/O.

### 3.3 Four causes, each confirmed outside the bench

**(a) The body index scans the whole FTS table for every body.**
`linkHttpBodyEvent` runs `DELETE FROM body_fts WHERE event_id=? AND sha256=?`
before indexing a body it has not seen. `event_id` and `sha256` are `UNINDEXED`
FTS5 columns, so SQLite reports `SCAN body_fts VIRTUAL TABLE INDEX 0:` and
reads every indexed body: 13 ms per call at 900 bodies, growing linearly. This
is the p95 slope in §3.1. For a new event the row cannot exist yet, so the
delete only ever finds nothing.

**(b) Opening a file right after writing it costs ~3.6 ms on Windows.** A
standalone probe (`probe-fs.cjs`): write 6 KB then reopen = 3.6–3.9 ms;
reopen an old file = 0.1–0.2 ms; write alone = 1.1 ms. Microsoft Defender scans
on the first open after a close-after-write. Ingest writes a body sidecar and
then immediately reopens it to verify and index it — on the request path.

**(c) `os.hostname()` per row: 200–316 µs each** on this box (probe, 300
calls). Every `insertChainedEvent` and `insertLoggedEvent` calls it; the value
does not change during a session.

**(d) RSS of the synchronous loop is a measurement trap, and also a hazard.**
The first `inproc` run reached 897 MiB RSS with a 33 MiB JS heap. The cause is
not a leak in RedLog's data structures: better-sqlite3 13.0.3 statements are
N-API objects whose finalizers run only when the event loop turns. A loop that
calls `db.prepare()` without yielding keeps every statement it ever prepared:
80,000 prepares of one SELECT took RSS from 49 to 331 MiB with the heap at
4–29 MiB, and `gc()` alone did not return it; the first `setImmediate` yield
brought it back to 112 MiB, and with a yield per round it stays there
(`probe-prepare.cjs`). Held, not lost — but held for as long as the loop runs.
The HTTP path yields per request (RSS
126–173 MiB above). Anything that runs ingest or queries in a long synchronous
loop on the main thread — the spool drain (235 MiB after 4,000 files), export
(§4) — pays it. `bench-ingest.ts` now yields once per cycle; `PERF_NO_YIELD=1`
reproduces the trap.

## 4. Export

```bash
node docs/perf-audit-2026-11/measure-app.mjs export <home> perf-large ndjson|json|har|bundle <outDir>
```

One fresh launch per format on the seeded project, default options (no
scope, no sanitisation), through the same `export:resolve` and
`export:execute` IPC calls the Export menu makes. Peak is the main process's
Windows peak working set (`PeakWorkingSet64`); before the export it was
180 MiB in every run.

| Format | events | resolve s | execute s | output MiB | main peak MiB | main after MiB |
|---|---:|---:|---:|---:|---:|---:|
| NDJSON | 198,380 | 29.0 | 68.1 | 288 | **4,555** | 1,514 |
| JSON | 198,386 | 27.2 | 64.7 | 377 | **4,176** | 1,381 |
| HAR (HTTP rows only) | 108,000 | 9.5 | 28.6 | 176 | 2,351 | 1,521 |
| Bundle | 198,396 | 28.9 | 69.5 | 283 | 2,701 | 579 |

(The event count grows by a few rows per launch: each start writes its own
system rows.)

Both phases run synchronously on the main thread, so for 1.5 minutes the
window does not repaint and capture does not ingest. Peak memory is 9–16× the
size of the file written, and after the export the main process keeps
0.6–1.5 GB.

Main-process profile, inclusive (NDJSON; the others have the same shape):

| Function | ms | share of 119 s sampled |
|---|---:|---:|
| `redactEventForExport` | 34,537 | 29% |
| ↳ `getSanitizedFields` — `db.prepare()` + `.all()` per event (prepare alone 22,981) | 33,057 | 28% |
| `queryEvents` (whole project, `limit: -1`) | 31,865 | 27% |
| `resolveExportPlan` | 27,099 | 23% |
| `eventsToNdjson` | 16,246 | 14% |
| `fingerprintValue` (SHA-256 per event) | 7,769 | 6.5% |
| `getCaptureHealth` (same process, same thread) | 18,908 | 16% |

`profile-summary.mjs --callers getSanitizedFields` shows it reached three
times per event:

```
11,546 ms  redactEventForExport < eventsToNdjson
10,961 ms  redactEventForExport < redactEventsForExport
10,550 ms  redactEventForExport < resolveExportPlan
```

So the plan reads the whole project (`queryEvents` via
`resolveExportSelection`, 9.7 s) and redacts every event to count it; the
execute step reads it again (18.7 s), redacts it in `redactEventsForExport`,
and `eventsToNdjson` redacts each event a third time; each redaction prepares a fresh `SELECT … FROM sanitized_events`
for one event id, on a project with no sanitised rows at all. Every event is
held in memory as a row, an event object, a redacted copy and a string before
anything is written.

`getCaptureHealth` (§1.3) took another 6–19 s of the same thread in each of
these sessions, asked for by the project open and the StatusBar poll.

## 5. Renderer bundle

```bash
npm run build
node docs/perf-audit-2026-11/bundle-attribution.mjs out/renderer/assets
```

`index.html` loads `main` and preloads `usePivots`, `vendor-xterm` and
`vendor-virtual`: **2.36 MB of JavaScript parsed before the picker**, plus
4 × ~1 MB Noto Sans TC woff2 files (fetched only when a glyph needs them).

| Chunk | bytes | loaded | dominated by |
|---|---:|---|---|
| `main` | 949,997 | start | js-yaml 98.5 KiB, `Timeline.tsx` 95.8, @dagrejs/dagre 62.5, `components/timeline/` 39.7, `ExportMenu` 36.4 |
| `usePivots` | 873,412 | start | react-dom 574.7 KiB; 262 KiB unmapped = `en.json` + `zh-TW.json` |
| `vendor-xterm` | 457,704 | start | @xterm/xterm 397.6 KiB, addon-search 39.0 |
| `Settings` | 193,824 | lazy | `components/settings/` 134.9 KiB |
| `vendor-virtual` | 80,398 | start | @tanstack/virtual-core 47.1 KiB |

Three things are in the startup path that the picker does not use:

- **Both locale files, always.** `I18nContext.tsx` imports `en.json` and
  `zh-TW.json` statically (126–129 KB each). Only one is ever shown.
- **js-yaml.** `lib/defaults.ts` imports `DEFAULT_CONFIG` from
  `core/config.ts`, which pulls js-yaml and Node's `crypto`/`fs`/`path` (left
  as externals) into the renderer for one constant.
- **dagre and xterm.** The causal graph and terminal views are not on the
  picker, but `CausalGraph.tsx` is a static import of
  `TimelineEventInspector` (so dagre is in `main`), and
  xterm is preloaded from `index.html`.

The renderer is not minified (electron-vite's renderer default). A what-if
build with `build.minify: 'esbuild'` (temporary config, deleted): JavaScript
**2,699,433 → 1,521,495 bytes (−44%)**, `main` 950 → 520 KB, `usePivots`
873 → 450 KB, xterm 458 → 322 KB.

It did **not** make startup measurably faster. Four interleaved pairs under
load: launch → picker 2.9–5.2 s default vs 4.3–6.2 s minified; navigation →
DOMContentLoaded 661–780 ms vs 592–935 ms. The variance from the box is larger
than the parse cost being removed, which is itself the finding: at
~0.4 s of renderer script on a cold start, bundle size is not where the
startup time goes. Treat the items above as size and hygiene, not speed.

## 6. Long-running memory

Not re-run here; summarised from `specs/063-long-recording-segments/pty-memory.md`
(#485) and the stream soak (#484).

**Main process over a long recording.** The pivot recompute on every command
was the first cause (#485: a command-heavy hour went from +43 MiB to
+14 MiB). What remains, ≈0.75 MiB/min early in a recording, is SQLite's page
cache filling: two connections, `SQLITE_DEFAULT_CACHE_SIZE=-16000` ≈ 15.6 MiB
each, ~31 MiB ceiling. It is flat once the database outgrows the cache (run L:
flat from minute 16; run M with a 2 MiB cache: +3 MiB in total). Projected over
8 hours: +31 MiB of cache plus a few MiB of heap — projected, not run for 8 h.

**Renderer.** ~6.5 MiB/min of allocation churn from `useAppCounts` `setState`
re-rendering the lucide icon tree; collected each cycle, RSS flat. Churn, not
growth.

**Streams (#484).** SSE + WebSocket soak, 120 min: PASS, app 528.9 →
521.8 MiB, mitmdump 109.7 → 72.4 MiB. PTY 60 min: +49.6 MiB against a 64 MiB
budget before the #485 fix.

What this audit adds (§3.3 d): a synchronous loop that prepares statements
holds their native memory until it yields — 235 MiB RSS after a 4,000-file
spool drain. It is not a leak and is not visible in the soaks above, because
those are event-driven; it is visible on the open after an outage and during
export (§4).

## Limits of this audit

- **One Windows laptop under load.** Other sessions shared the box; the
  startup A/B in §5 shows how much that moves absolute numbers. Ratios,
  slopes and profile shares are the findings. §3.3 (b) and (c) are
  Windows-specific (Defender, `os.hostname()` cost) and should be re-checked on
  macOS and Linux before being used to rank there.
- **No packaged installer.** `out/` runs the same JavaScript; ASAR reads and
  code signing are not in these numbers.
- **The seeded project has no HTTP bodies on disk.** `seed-project.ts rows`
  inserts rows through `insertEvent()` with bodies removed, so 200k rows fit in
  ten minutes. Body search coverage, body-file counts and the picker walk
  (§1.1) are therefore smaller than on a real project of the same row count —
  every effect of that omission makes the real numbers worse, not better.
- **UI-side timings are partial.** The IPC wrapper in `measure-app.mjs` relies
  on `ipcMain._invokeHandlers`, which Electron 44 does not expose, and the
  Search view's input did not appear within 30 s under load; the timings in §2
  are the same requests issued through the preload bridge.
- **`app.close()` did not return after a large export or project run.**
  Each `measure-app.mjs` run had written its results first; the harness
  then hung in Playwright's close until the app was killed. Not investigated
  (closing RedLog's window hides it rather than quitting), and no
  number above depends on it.
- **The 8-hour memory figure is a projection** from #485's runs, not a run.

## Reproduce

All commands run from the repository root after `npm ci && npm run build`.
Benches write into a throwaway `HOME`; nothing touches `~/.redlog`.

| Section | Command |
|---|---|
| §1.1 | `node docs/perf-audit-2026-11/measure-app.mjs startup 5` |
| §1.2, §2 (app) | `measure-app.mjs create <home> perf-large`, then `PERF_HOME=<home> node docs/perf-audit-2026-11/run.mjs seed-project.ts -- <project dir> 18000`, then `measure-app.mjs project <home> perf-large <outDir>` |
| §1.3, §2 (main) | `node docs/perf-audit-2026-11/run.mjs bench-query.ts [--prof] -- <project dir> 5`; `node docs/perf-audit-2026-11/probe-capture-health.cjs <project dir>/timeline.db` |
| §3 | the `bench-ingest.ts` commands at the top of §3; `node docs/perf-audit-2026-11/probe-fs.cjs`; `node --expose-gc docs/perf-audit-2026-11/probe-prepare.cjs` |
| §4 | `node docs/perf-audit-2026-11/measure-app.mjs export <home> perf-large ndjson\|json\|har\|bundle <outDir>` |
| §5 | `node docs/perf-audit-2026-11/bundle-attribution.mjs out/renderer/assets` |
| profiles | `node docs/perf-audit-2026-11/profile-summary.mjs <file.cpuprofile> [--total fnA,fnB] [--callers fn] [--map out/perf-audit/<bench>.cjs.map]` |

`seed-project.ts` writes into a project an Electron launch created, so the
rows are signed with that home's operator key and the app opens the project
as its own.
