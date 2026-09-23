# Research: Loot Rule Time Bound

- **Why a worker, not a safer regex engine**: RE2-style engines are native
  modules and change pattern semantics (no backreferences, no lookaround) for
  existing plugins. A worker keeps JavaScript semantics.
- **Why synchronous**: `findMatches` feeds redaction on the ingest path before
  the row is written; making it async would change the write path.
  `Atomics.wait` + `receiveMessageOnPort` is allowed on Node's main thread.
- **Measured**: prototype — an ordinary rule round-trips in ~8 ms including
  first use; `(a+)+$` on 32×`a`+`!` was cut at the 200 ms bound and the worker
  terminated.
- **Why built-ins stay in-process**: they are part of the reviewed code, run on
  every row, and have golden tests; the worker hop would add cost for no
  protection.
