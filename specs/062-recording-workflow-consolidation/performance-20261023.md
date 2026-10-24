# Measured performance follow-up — 2026-10-23

Scope: local Zsh command overhead, SQLite event/HTTP queries and settings field
lookup. Measurements use isolated synthetic fixtures, not an operator's project.
Apple M2 Pro (10 threads), 16 GiB, darwin 27.0.0, Node v26.12.1 and Homebrew
Python 3.15. Local results vary with system load; these are not installer,
Windows/PowerShell, Bash or native page-rendering acceptance.

## Retained changes

1. The relay loads HTTP/TLS, pathlib, subprocess and datetime only where used.
   Ordinary auto-captured commands avoid those startup costs. Debug logging,
   explicit execution and late-output delivery still load their dependencies.
2. HTTP flow selection ranks metadata rather than full event JSON containing
   inline bodies. The subsequent query still returns the complete selected
   request/response evidence. No body limit, schema, index or cache was added.

## Real Zsh PTY benchmark

`REDLOG_PERF=1 npx vitest run test/zsh-latency.pty.test.ts --maxWorkers=1 --no-file-parallelism`

Two rounds per shape, bare shell versus adapted shell, omitting the driver's
250 ms drain from prompt timing. Every measured command_end must arrive.
Separate complete before/after runs passed all three benchmark cases.

| Shape | Samples | Added median before | Added median after |
| --- | ---: | ---: | ---: |
| No output | 60 | 216 ms | 169 ms |
| One line | 60 | 206 ms | 185 ms |
| 2,000 lines (~9 KB) | 40 | 195 ms | 174 ms |
| 200,000 lines (~1.3 MB) | 12 | 330 ms | 274 ms |

The no-output median fell about 22%; its added p95 fell from 337 to 181 ms.
Large-output timing includes terminal work and is noisier, with only 12 samples;
do not infer a general rendering improvement. A separate interleaved
before/after/after/before no-output check observed 215.8 → 167.0 ms medians and
verified 84 command_end records. The final full after run above was performed
without concurrent benchmark/build workloads.

Profiling identified eager urllib.request/HTTP/TLS imports on every helper
invocation. A 25-process state-only probe observed median process time
67.43 → 32.75 ms, but process-start timing is supporting evidence, not a
replacement for the shell benchmark.

An experiment that shortened the select wait once a finish signal arrived did
not improve the interleaved result (170.8 ms versus the imports-only 167.0 ms).
It was removed. Existing drain windows, caps, truncation markers, command
classification, exit codes and spool policy remain unchanged. The remaining
~169 ms command overhead is real; this change does not claim zero friction.

## HTTP body-heavy query

`REDLOG_PERF=1 npx vitest run test/http-flow-query-perf.test.ts --maxWorkers=1 --no-file-parallelism`

5,000 complete flows / 10,000 logged rows, ten hosts, approximately 40 MB of
inline request/response body characters. Select the first 500 flows, warm once,
then report the median of five runs. Each run asserts 500 flows, 1,000 evidence
rows and an intact response body. Timed scope includes SQLite selection and
row conversion; it excludes IPC, React rendering and body display.

| Query | Before | After | Separate after rerun |
| --- | ---: | ---: | ---: |
| All | 331.34 ms | 79.75 ms | 86.5 ms |
| 4xx | 311.20 ms | 81.90 ms | 81.7 ms |

Approximately 74–76% lower elapsed query time on this fixture. The retained
benchmark is opt-in like timeline-query-perf; its 200 ms local budget does not
become a shared-CI hardware timing promise. The added behavior case passed on
the original implementation before optimization and preserves earliest-request,
latest-response, case-insensitive host filtering, duplicate evidence, Unicode
bodies and snapshot boundaries after a later response arrives.

## Measured paths left unchanged

`REDLOG_PERF=1 npx vitest run test/timeline-query-perf.test.ts --maxWorkers=1 --no-file-parallelism`

100,000 events split evenly between tiers, 200 targets, median of five warm
runs: ordinary first page 1.0 ms; scoped first page 83.9 ms; scoped count
77.0 ms; 60 live bursts of 100 IDs 32.6 ms. All nine existing budget cases
passed. No broad event-query redesign was justified by this measurement.

Settings field lookup across both locales and five queries measured
0.022–0.070 ms per call over 200 calls each. No cache was retained. This
measures pure lookup CPU, not native settings navigation or React rendering.
The temporary lookup and interleaved shell profiling harnesses were removed;
the existing shell/event benchmarks and new body-heavy HTTP benchmark remain.

## Verification boundary

The HTTP regression batch passed six files / 59 tests, including flow queries,
public query resolution, HTTP loading and export-plan IPC. Shell regression,
build and project-gate results are recorded in verification.md once complete.
No real traffic, existing evidence, terminal theme, capture limits or privacy
policy was modified for performance. Spec 062 remains Draft; its installer and
cross-platform acceptance tasks stay open.
