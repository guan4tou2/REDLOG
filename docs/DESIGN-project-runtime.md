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
- **Cast backfill closed the next project's index.** The cast index is one
  handle per process. `backfillCastIndex` kept going after its project closed,
  and each `indexCast(file, oldDir)` reopened the old index, closing the
  handle the new project was using. `test/cast-index.test.ts` "stops a
  backfill at the next file once its project has closed" reproduced it.

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

## 3. Order, and what each step must not break

Carried over from the proposal with one change: R1 splits, because the defect
it was meant to prevent is real and smaller than the whole lifecycle.

| Step | Work | Must hold |
|---|---|---|
| R0 | real-source e2e runs in CI (#464) | a skipped real-source spec fails the job |
| **R1a** | runtime generation, signal, owned timers; the two defects above | done — see §4 |
| R1b | services onto `onStop`, one per change; identity from `current()` | `stopProject` order unchanged, each move pinned by a test |
| R1c | a write guard below `getDB()`: refuse a row whose engagement is not the open database's | the last line of defence for anything R1a/b missed |
| R2 | ingest stages made explicit (policy, identity, provenance, enrichment, write, derive, notify) | A→B binding, pause, queue-full gap, unconfirmed delivery, dedup, hash chain — as characterization tests first |
| R3 | `api-server.ts` split by capability, no framework | loopback/host/token/size/project-identity checks stay in one unskippable entry |
| R4 | Timeline query + live admission controller | same query and snapshot give the same rows |
| R5–R8 | navigation contract, settings write controller, cleanup, release acceptance | Spec 064 parity before the main navigation changes |

Not doing, as the proposal argues: Tauri, another database, microservices,
plugin-izing the core, global state stores, a bulk move of `src/core/`, any
evidence-schema change during a refactor.

## 4. Snapshot (2026-10-30)

- R1a is on `refactor/project-runtime`.
- Still unguarded by the runtime: `casts:reindex` in `main/ipc/terminal.ts`
  calls `backfillCastIndex(dir)` without a signal (it has no runtime access
  yet — R1b), and `insertEvent` itself has no project guard (R1c).
- R0 (#464) is in progress on its own branch.
