# Data Model: IP Verdict Display

Nothing here is persisted. Every entity lives in memory in the main process and
travels over IPC and the local API. The chain's `ip_verdict` events are
unchanged.

## IP verdict (unchanged)

`IPVerdict` in `src/core/alert/policy.ts`, decided by `IPPolicy.classify()`.

| Field | Values |
|---|---|
| `value` | `exposed` · `off_profile` · `safe` · `presumed_safe` · `unknown` |
| `authority` | `fact` · `inferred` · `unknown` |
| `severity` | `clean` · `notice` · `warning` · `critical` |
| `settling`, `stale`, `listConflict`, `lanSafety` | optional modifiers |

`BadgeSurface` holds the last emitted verdict. Only its `value` feeds the
display (research R3).

## Reading state (producer)

`IPProducerState` in `src/main/services/producers/ip-signal-producer.ts`.

| Field | Meaning | Change |
|---|---|---|
| `external` | the last stable address. A settling candidate never overwrites it | — |
| `internal` | the local interface address | — |
| `lastCheck` | when the last read finished, success or failure | — |
| `error` | the provider's error text from the last failed read. `null` after a success | — |
| `settling` | a different address was read and is not yet confirmed | — |
| `stale` | the last read failed | — |
| `failure` | why it failed: `air_gap` when `offline` was set for that read, otherwise `lookup_failed`. `null` after a success | **new** (R5) |
| `link` | the Wi-Fi or wired link, filtered for display | — |

## Last reading (runtime)

This is private to `AlertRuntime`. It is `{ state: FreshState; at: number }`, or
`null` before the first successful read.

- `FreshState` is one of `exposed`, `off_profile`, `safe`, `presumed_safe` or
  `unconfigured`: a display state that rests on a current reading.
- The record is written on every producer tick where `stale` is false and
  `external` is set. Its `state` is the display state of the badge's verdict at
  that moment, and its `at` is the tick's `lastCheck`.
- Nothing else writes or clears it. A failed read, air-gap mode, a settings save
  and a project switch all leave it as it is (research R4).

## Display state

`IPDisplayState` in `src/core/alert/ip-display.ts`:
`exposed` · `off_profile` · `safe` · `presumed_safe` · `unconfigured` ·
`no_reading` · `checking`.

`ipDisplay(input)` is pure. The first row that matches decides:

| # | Producer `stale` | Producer `external` | Badge `value` | `ipSafety` | `alarm` | `reason` | `lastReading` | `settling` |
|---|---|---|---|---|---|---|---|---|
| 1 | true | any | any | `no_reading` | the last reading is `exposed` or `off_profile` | `failure` (default `lookup_failed`) | the last reading | false |
| 2 | false | `null` | any | `checking` | false | `null` | `null` | false |
| 3 | false | set | `null` | `checking` | false | `null` | `null` | false |
| 4 | false | set | `exposed` | `exposed` | true | `null` | `null` | producer's |
| 5 | false | set | `off_profile` | `off_profile` | true | `null` | `null` | producer's |
| 6 | false | set | `safe` | `safe` | false | `null` | `null` | producer's |
| 7 | false | set | `presumed_safe` | `presumed_safe` | false | `null` | `null` | producer's |
| 8 | false | set | `unknown` | `unconfigured` | false | `null` | `null` | producer's |

Row 3 covers the moment between a successful read and the badge's first
verdict. It cannot outlast one tick.

### The nine A.1 cells (SC-001)

With a current reading:

| Cell | Lists | Address | `ipSafety` |
|---|---|---|---|
| A-1 | none | — | `unconfigured` |
| A-2 | Exposed only | on it | `exposed` |
| A-3 | Exposed only | not on it | `presumed_safe` |
| A-4 | Safe only | on it | `safe` |
| A-5 | Safe only | not on it | `off_profile` |
| A-6 | both | on both | `exposed`. The list conflict is not shown (out of scope) |
| A-7 | both | on Exposed only | `exposed` |
| A-8 | both | on Safe only | `safe` |
| A-9 | both | on neither | `off_profile` |

A failed read in any of these cells gives `no_reading` with
`reason: 'lookup_failed'`. Air-gap mode gives `no_reading` with
`reason: 'air_gap'`.

## Invariants on `IPStatus`

The wire shape is described in [contracts/ip-status.md](contracts/ip-status.md).

1. `reason` is set only when `ipSafety` is `no_reading`, and is always set then.
2. `lastReading` is set only when `ipSafety` is `no_reading`. It stays `null`
   when no read has ever succeeded.
3. `alarm` is true exactly when `ipSafety` is `exposed` or `off_profile`, or when
   `ipSafety` is `no_reading` and `lastReading.state` is `exposed` or
   `off_profile`.
4. `settling` is true only together with a current reading (rows 4–8).
5. While `ipSafety` is `no_reading`, `externalIP` is the last known address and
   `lastReading.at` gives its age. It is `null` if no read has ever succeeded.

## Transitions

```text
                   first read ok                       read ok (verdict may change,
   checking ───────────────────────► current ◄──────── settling may start or end)
      │                              (rows 4–8)  ──┐
      │ first read fails                 │         │ read ok
      ▼                                  │ read    │
   no_reading ◄───────────────────────────┘ fails  │
   (lastReading = null)          (lastReading = the current state)
      │ read ok                                    │
      └────────────────────────────────────────────┘
```

- **An alarm held through a failure.** `exposed` or `off_profile` followed by a
  failed read gives `no_reading` with `alarm: true`. It stays held until a read
  succeeds, and that read decides the new state.
- **A settings save.** It restarts the producer: `configure()` re-arms the
  timer, and `start()` reads at once. The surfaces move with that read, as
  today. `IPPolicy.configure()` resets the dedup, so the read's verdict is
  emitted even when unchanged.
- **Air-gap mode.** Turning it on makes that immediate read, and every later
  one, fail with `reason: 'air_gap'`. Turning it off lets the immediate read
  decide.
