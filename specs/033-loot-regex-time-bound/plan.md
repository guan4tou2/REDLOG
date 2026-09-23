# Implementation Plan: Loot Rule Time Bound

## Canonical module interface

`core/bounded-regex.ts` — `runBounded(rules, text, timeoutMs)` returns every
rule's matches, or the index of the rule that was running at timeout. Only
`loot-detector.ts` calls it.

## Constitution Check

- **Explicit Failure**: a stopped rule is reported, not silently skipped.
- **Surface Truthfulness**: Settings states that a stopped rule no longer masks.
- **Architectural Restraint**: one module, one worker, no new dependency; the
  synchronous detector API is kept.
- **Risk-Based Test-First Verification**: the RED run is the hang itself.

## Design

1. A worker (inline source, `eval`) runs the rules; it writes the index of the
   rule in progress and a done flag into a SharedArrayBuffer, and posts the
   matches on a MessageChannel.
2. The caller posts the job, blocks with `Atomics.wait` for the budget, and
   reads the reply with `receiveMessageOnPort`. On timeout it terminates the
   worker; the next call starts a fresh one. Startup waits on a ready flag.
3. `loot-detector` runs plugin rules through it, marks an overrunning rule
   `stopped: 'time_limit'`, and retries the rest.
4. `listLootRules()` carries `stopped`; `LootRulesGroup` shows it.

## Domain invariants

Masking and recording (Specs 031, 032) are unchanged for every rule that runs.
