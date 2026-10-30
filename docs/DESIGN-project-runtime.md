# Project runtime and the refactor order — 2026-10-30

A review of the proposal to move REDLOG from accumulated features to domain
modules, checked against `main@78a4cbd3`, and the first slice of it (R1a)
built. The proposal's direction is accepted: no rewrite, no new framework, a
modular monolith reached by strangler-fig steps that each merge on their own
and leave every saved project readable. This note records which of its
premises held against the code, what R1a changed, and what comes next.

§1–§3 are agreed. §4 is a dated snapshot and will go stale.

## 1. What the proposal got right, checked

| Claim | Checked | Note |
|---|---|---|
| `src/main/index.ts` ≈ 2,127 lines mixing lifecycle, sources and IPC | 2,129 | `startProjectResources` alone is ~470 lines and starts 20+ services |
| `Timeline.tsx` ≈ 2,695 | 2,694 | already has `timeline/` children; split by data responsibility, not by file size |
| `api-server.ts` ≈ 903, `ingest.ts` ≈ 626 | 902, 625 | |
| `src/core/` is flat | 101 entries at the root | move a domain only when its dependencies are already sorted |
| Project lifecycle is coordinated by module variables | yes | `activeProject`, `currentEngagementId`, four timers, and each async continuation's own idea of "still open" |

The proposal names *async work writing to the wrong database after a switch*
as the first thing a runtime boundary buys. That was a prediction. Reading the
continuations that outlive `startProject` turned it into two defects:

- **Scope recompute wrote into the next project.** `runScopeRecompute` reads
  the open database, yields to the loop twice, then writes through `getDB()`.
  `insertEvent` has no project guard. A switch inside either yield put the
  first project's `scope_recomputed` row and its retroactive violations — with
  the first project's engagement id and event ids — into the second project's
  chain. `test/scope-recompute-run.test.ts` "a project switch while it runs"
  reproduced it (`ran: true` against the second database) before the fix.
- **Cast backfill — corrected in R1c.** R1a said the backfill could outlive
  its project and close the next project's index handle. It could not:
  `indexCast` is synchronous, so the loop's `await` only yields to
  microtasks and a switch (an IPC, a later turn) cannot land inside it. R1a's
  test aborted in the same turn, which no real switch does. What was real is
  the cost of that: the whole backfill ran in one turn right after an open and
  held the main process. R1c makes it yield between files, which opens the
  switch window for real, and closes it with the signal and `dbGeneration`.

And one weaker case: the HTTP auto-start guard compared project ids, so after
A → B → A the first A's continuation counted as the second A's attempt.

## 2. R1a: what `ProjectRuntime` is, and is not

`src/core/project-runtime.ts`. One open project as the main process sees it:

- `begin(identity)` → `ProjectContext { projectId, engagementId, operatorId,
  generation, signal }`, state `opening`. Refuses while an open is live: the
  caller owns the order of a switch.
- `activate(context)` → `active`.
- `close()` aborts the signal, then runs the open's cleanups newest first.
  Every one runs; the first failure is rethrown after the last. An open that
  never reached `active` ends `failed`, not `closed`.
- `isCurrent(context)` for code that cannot take a signal.
- `setInterval` / `setTimeout` / `onStop` against a context. Against an open
  that has already ended, a timer is not started and a cleanup runs at once,
  so a late `.then` cannot leave a timer running into the next project.

Moved onto it in `main/index.ts`: the chain-sample, logged-tier and spool-drain
intervals (three module variables and their clears are gone), the HTTP
auto-start guard, the cast backfill (`signal`), and the scope recompute
(`signal`, new result `superseded`). `stopProject` closes the runtime first,
so nothing the old open started can begin anything new while the rest of it
is taken down.

What it deliberately is not, yet:

- **Not a resource registry.** The proposal's `ManagedResource { start, stop }`
  is the direction, but `stopProject`'s explicit list stays. Its order is a
  contract (terminal bindings finish while the DB is open; the API binding is
  dropped before the spool identity), and moving twenty services behind an
  interface in one change would make that order implicit. Services move onto
  `onStop` one at a time, each with a test that pins its place.
- **Not the identity source.** `activeProject`, `currentEngagementId` and
  `currentOperatorId` still exist. Replacing them with `projectRuntime.current()`
  touches every IPC handler and is its own slice.
- **Not a transaction.** Switching stops the old open, then begins the new
  one. A failed open is cleaned up and reported; it does not restore the old
  project. That was already true and is now stated.

## 2b. R1c: the write guard, and what the await audit found

**Guard.** `bindDBEngagement(id)` right after `initDB` in `startProject`;
`closeDB` forgets it. From then, `insertEvent` refuses a row whose explicit
`engagementId` is not the bound one, for both tiers, with a `console.error` —
not `noteDbError`, which would turn the open project's verdict dark when its
own log is fine. An omitted id is stored as `default` as before. In memory,
no schema change. It covers rows only: `chain_anchors`, bookmarks and the
other direct-SQL tables are guarded at their writers below.

It found one legitimate writer first: the updater's restart marker spelled
`engagementId: 'default'` out, which the guard would have refused in every
open project. It now passes the id it was given (none).

**`dbGeneration()`.** Moves on every `closeDB`. Core code that reads, awaits,
then writes and has no runtime signal takes it before the await and compares
after.

**Audit.** Every read → await → write in `src/core` and `src/main`, checked
against a switch landing in the await. Fixed here, each with a test that fails
on `main`:

| Path | What a switch did | Now |
|---|---|---|
| `anchorNow` (anchor loop, `chain:anchorNow`, `POST /api/anchors`) | wrote A's head into B's `chain_anchors` after up to 15 s of calendar waits; B's verify then reads tampering | generation check, returns null |
| anchor and NTP loops' first tick | never stored, so never cancelled: a switch to an air-gapped project inside 30 s / 5 s still sent its chain head to the public calendars, or a time query | stored, cleared by stop |
| CDP navigation poll | the stopped monitor kept A's identity: the navigation was written into B under A's engagement, and the same poll opened tab sockets that kept writing the console into B | stop clears the identity |
| screenshot capture | B got a frame taken in A, `_causes` pointing at A's event, or a row pointing into A's `screenshots/` | generation checked after the grab and after the write; file removed |
| `startManagedHttpCapture` | a start cancelled by the switch was published as B's `http_proxy_failed` | checks its open after each wait, including the port-release wait #464 added |
| `/api/marker`, `/api/bookmarks`, `/api/sanitize` | wrote into B after reading a slow body, with A's operator | same 409 recheck `/api/events` has |
| `bookmarks:create` IPC | a bookmark saved in A landed in B after the 2 s browser query | checks its open after the query |
| cast backfill | see §1 | yields; signal + generation |

Held by the audit: the spool, retention and sample timers (runtime-owned),
process/connection/file/PowerShell monitors (generation guards, identity read
at write time), tailer timers (cleared on stop), clipboard (synchronous read),
IP checks (machine data), `/api/events` and artifact add (already recheck).
`upgradeAnchor` fails closed by accident — its captured handle is closed —
and is left for R1b to make deliberate.

## 3. Order, and what each step must not break

Carried over from the proposal with one change: R1 splits, because the defect
it was meant to prevent is real and smaller than the whole lifecycle.

| Step | Work | Must hold |
|---|---|---|
| **R0** | real-source e2e runs in CI | done (#464) — a skipped real-source spec fails the job |
| **R1a** | runtime generation, signal, owned timers; the two defects above | done (#466) — see §2 |
| R1b | services onto `onStop`, one per change; identity from `current()` | `stopProject` order unchanged, each move pinned by a test |
| **R1c** | write guard, `dbGeneration`, the audit's switch-time writes | done (#467) — see §2b |
| R2 | ingest stages made explicit (policy, identity, provenance, enrichment, write, derive, notify) | A→B binding, pause, queue-full gap, unconfirmed delivery, dedup, hash chain — as characterization tests first |
| R3 | `api-server.ts` split by capability, no framework | loopback/host/token/size/project-identity checks stay in one unskippable entry |
| R4 | Timeline query + live admission controller | same query and snapshot give the same rows |
| R5–R8 | navigation contract, settings write controller, cleanup, release acceptance | Spec 064 parity before the main navigation changes |

Not doing, as the proposal argues: Tauri, another database, microservices,
plugin-izing the core, global state stores, a bulk move of `src/core/`, any
evidence-schema change during a refactor.

## 4. Snapshot (2026-10-30)

- Merged: R0 (#464), R1a (#466), R1c (#467).
- Next is R1b, one service per change, in this order:
  1. `upgradeAnchor` fails closed only by accident (its captured handle is
     closed). Make it check its open.
  2. The capture browser's CDP monitor is not restarted for the next project:
     it stops at a switch and starts again only with a new launch.
  3. Identity from `projectRuntime.current()`, then retire `activeProject` /
     `currentEngagementId` / `currentOperatorId`.
- R1b and anything else that edits `src/main/index.ts` run one at a time: #464
  and R1c met there in one function.
- R2 is unblocked by R0. It starts with the characterization tests in §3, not
  with moving code.
- Beside the refactor, not in it: the rest of #291 (a hard kill loses up to
  64 queued events with no record, the HAR does not carry a stream's end
  state, soak runs). None of it needs `src/main/index.ts`.
