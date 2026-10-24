# Capture trust contract — 2026-10-24

Outcome of a review round that followed Spec 062: a UI/UX pass, then capture
coverage, output completeness, privacy and cost. It ended in fewer features, not
more. Everything here refines what is already settled:
[`DESIGN-core-and-capture.md`](DESIGN-core-and-capture.md) put *knowability* at
the core, and [`DESIGN-PRINCIPLES.md`](DESIGN-PRINCIPLES.md) §3 says never write
interpretation as fact. This note says what those two mean for capture, storage
and the screens that read them back.

§1–§11 are agreed. §12 is a dated snapshot of where the code stands and will go
stale; check it against the code before acting on it.

---

## 1. Two invariants

RedLog cannot record everything an operator does, and must not claim to. What it
can promise is that it never lies about the gap:

- **Capture completeness** — never present *not captured* as *did not happen*.
  An empty output, a missing row or a quiet source must be distinguishable from
  one that was recorded and empty.
- **Privacy boundary** — never present *hidden* or *not exported* as *not
  saved*. A filter, a redaction or an export exclusion acts on what is already
  stored; only stopping at the capture boundary means it was never kept.

Every rule below is one of these two applied somewhere specific.

## 2. Progress follows persistence

A source's progress marker — a cursor, a count, an index of processed files —
may advance past an item only after that item's event is durably written.

1. **Commit after the write, not before.** A marker written first turns a failed
   or interrupted write into a permanent skip: the source looks healthy and the
   item never appears.
2. **Retry without waiting for the next change.** The last command of a session
   may never be followed by another file event. A failed item gets a bounded
   retry of its own.
3. **Retry must not duplicate.** Where the write and the marker are not atomic,
   deduplicate on the source item's stable identity (a UUID, a file name, a
   command's position), so a crash between them repeats nothing.
4. **Keep three outcomes apart.** *Parsed and deliberately ignored*, *skipped
   because recording was paused* and *failed to persist* are different states.
   None of them may be counted as the others.
5. **Prove it with fault injection.** A reliability fix ships with a test that
   makes the write fail and fails on the old code. A test with only well-formed
   input proves nothing about this.

No per-item acknowledgement events: the marker is the acknowledgement, and an
extra row per item would multiply I/O for nothing.

## 3. Pause means RedLog stops keeping new content

Pausing says *this stretch is not part of the engagement record*. It stops more
than the searchable events.

| | Event store | RedLog's raw copy (sidecar) | After resume |
|---|---|---|---|
| Recording | written | written | — |
| Paused | not written | **not written** | nothing from the pause is back-filled |
| Resumed | written | written | starts from the resume point |
| Excluded from export only | written | written | kept, not delivered |

- What a pause may leave behind is the gap itself: when it started and ended,
  which source, and how many items were skipped. Never their content.
- A tailer needs two positions, not one: the **source cursor** (how far the
  source has been consumed) and the **evidence offset** (how much raw data
  RedLog kept). They move together while recording and apart while paused. A
  tailer that derives its read position from the sidecar's size will re-read
  the pause on resume if the sidecar simply stops growing.
- Crash during a pause, restart and source-file rotation must all be tested not
  to pull paused content back in.
- RedLog speaks only for its own storage. Claude Code, Codex and others keep
  their own histories; copy may promise what RedLog does not keep, never what
  the tool does not keep.

## 4. Output completeness

> A command RedLog reports as fully captured must have its complete observed
> output retrievable. Where interactivity, redirection, size, a source failure
> or a pause prevented that, the record says so. An empty output or a success
> state never stands in for it.

**States.** Every output-bearing record (command, AI tool result, HTTP body,
`.cast`, screenshot, artifact) resolves to one of:

| State | Meaning |
|---|---|
| complete | everything within the capture path was kept |
| truncated | a size limit cut it; the limit is named |
| metadata-only | the action is recorded, its output is not |
| not recorded by choice | the operator or a policy excluded it |
| failed to save | a write was attempted and failed |
| unknown | there is not enough to say either way |
| pruned | kept once, later removed by retention |

An empty stderr can be a complete zero bytes; an uncaptured stderr is a
different state and must look different. The shell relay already emits
`completeness` (`complete` / `truncated` / `metadata-only`); other sources
converge on the same vocabulary, each keeping its own limits and storage.

**Never change what the tool does to record it.**

| Situation | Rule |
|---|---|
| `nmap`, `ffuf`, `netexec`, `sqlmap` | full stdout/stderr through the relay |
| `ssh`, interactive `smbclient`, `msfconsole` | the PTY recording is the evidence; do not pretend each REPL line is a hooked command |
| `nc`, `ncat` | no relay or wrapping — it breaks shell upgrades and job control |
| `vim`, `less` | native class; a redraw is not output |
| `cmd > out.txt` | never rewrite to `tee`; record *output redirected*, and keep the file through the artifact flow if it matters |
| CMD | PTY and recording, no claim of a command hook |

**Large output goes to disk as it arrives**, through bounded buffers, not held in
memory until the command ends. A project storage limit still applies, and
reaching it is recorded as `truncated` or a save failure, never by filling the
disk. A UI preview limit is not a storage limit: a preview may stop at 100 KiB,
the evidence may not.

## 5. Network capture: HTTP(S) first

- HTTP and HTTPS through the proxy are the primary network evidence: request,
  response, headers, body, status, timing. WebSocket and HTTP/2 ride the same
  path.
- SMB, LDAP, RDP, SSH and scans are evidenced by **the tool's own output**, the
  target and the time. Connection metadata from the optional monitors can
  supplement it. Packet capture stays an optional, advanced extension, with no
  further core UI or automation.
- Tool output about SMB is the tool's account, not packet-level observation.
  The source identity says which it is; nobody is pushed into PCAP to fix that.
- Three HTTP states are never collapsed: **proxy running**, **client verified**
  (this client's traffic does pass through), **flow saved**. Traffic the proxy
  never saw — raw TCP, SMB, a SYN scan — is never shown as captured HTTP.
- Never redirect the whole machine's traffic to catch more HTTPS. Each client
  (Burp, browser, `curl`, `requests`) is routed and verified on purpose.

## 6. Evidence levels

The same operation can leave a shell row, a process, a connection, a flow and an
AI tool call. Relations between them carry how they are known:

| Relation | Level |
|---|---|
| shell hook recorded the command | direct observation |
| proxy received the request/response | direct observation |
| AI transcript says it ran a command | source narrative |
| socket → PID → command links a connection to a command | attribution, with its basis kept |
| a screenshot and a flow close in time | time correlation only |
| traffic with no source found | unattributed, and shown as such |

Closeness in time is never written as causation. An AI tool result is not
independent proof the tool ran. These distinctions belong in the existing
inspector and exports, not in a new correlation engine.

## 7. Privacy: existing boundaries, decided at capture

- No automatic private-versus-work classification of commands, URLs, history or
  cookies. It is inaccurate, invasive and expensive.
- The boundaries are the ones that exist: AI working-directory authorization,
  personal domains, the recording switch, Do Not Export, export redaction.
  Keeping something out of storage happens at the capture boundary; hiding it
  in a view does not count.
- `hidePersonal` and personal domains act on events with a target. An event
  with no target is not thereby safe, nor thereby part of the engagement.
- Host monitors (clipboard, process, connection) have no engagement context of
  their own. They stay off by default and individually switchable, each stating
  what it reads.
- Export checks run at export time, against everything the bundle carries:
  headers, cookies, URL tokens, a `.cast` that spans targets, screenshots with
  no target, attachments the operator added. Event JSON passing is not the
  bundle passing.

## 8. Reading back reliably

What the screens owe the operator while recording continues:

- **New data never blanks a view.** Pages merge incoming rows by event id;
  loading older pages, live refreshes and pair completion go through one merge.
  A result from a superseded query is discarded. Only a real filter change
  rebuilds the list.
- **The reader keeps their place.** Position is held by the visible event's id
  and its offset in the viewport, not by `scrollTop`. Follow the live end only
  when the reader is at it, and where the live end is depends on sort order
  (top when newest-first, bottom when oldest-first). Rows that arrive while
  reading history are counted, not scrolled to.
- **A subset says it is a subset.** Capped and paged results state what was
  loaded; where per-type buckets cover different time spans, the view does not
  read as complete across all of them.
- **Failure never looks like an answer.** Loading, empty and error are distinct
  in every reading surface. A failed read is not "no events", and no observed
  violation is not "everything in scope".
- **One state per source, one name per event.** Dashboard, status bar and
  Settings show the same lifecycle; a source has one place it is configured.
- **Go to the event, not the time.** Cross-page navigation carries the event id
  and returns to the filter and position it left.

## 9. Cost discipline

Detect known failures; do not try to prove that nothing was missed. Without an
independent observer that cannot be done, and attempting it costs constantly.

- Event-driven, not scanning: gaps and errors are recorded when state changes or
  a write fails. Repeated identical failures are coalesced into a count.
- Checks that are expensive (export privacy checks, integrity verification)
  run on demand, never on the capture path.
- Capture latency outranks dashboard freshness. Recording a command or a request
  must not perceptibly slow the tool being used.
- Measure before accepting a change under four load profiles: no optional
  monitors, shell + AI, shell + HTTP, all optional sources. Otherwise a monitor's
  CPU is blamed on the UI, or the reverse.
- Memory does not grow with total events or total output; long output costs
  disk, within quota.

## 10. Not building

| Tempting | Why not |
|---|---|
| AI chat page, model switching, agent dispatch | conversation is a capture source, read in the Transcript |
| a second timeline for agents | one event store, read several ways |
| Burp Repeater/Intruder | Burp already exists and the operator uses it |
| reports, CVSS, findings with remediation | downstream tools' job |
| inferring causation from timing | produces false evidence |
| installing shells or proxies for the operator | detect and explain; do not modify their machine |
| global keylogging, full desktop tracking, always-on raw PCAP | outside the privacy boundary and the cost budget |
| a second session, finding or evidence store | one source of truth |
| a coverage dashboard or privacy centre | the existing capture health and export preview carry this |

## 11. Delivering changes

- One reliability fix, one commit, its own fault-injection test. A fix that does
  not depend on a candidate branch goes to its own branch off `main`, not onto
  the candidate.
- A branch is not finished when it is pushed. Finished means pushed, with a PR,
  a known CI result, and every unrun acceptance item listed where it will be
  seen.
- A test blocked by the environment (a sandbox refusing `mktemp`, a socket, an
  Electron launch) was not run. It is reported as blocked, never as passed or
  failed.

## 12. Status snapshot (2026-10-24)

Line references drift; the function names are the stable handle.

| Item | Where | Status |
|---|---|---|
| Transcript reloaded and blanked on every batch | `TranscriptView.tsx` | **Fixed** in `0f1f3746` (PR #437): merge by id, position by visible row, follow by order |
| PowerShell count advanced past failed writes; pause back-filled on resume | `powershell-transcript.ts` `follow()` | **Fixed** in PR #438. Retry state is in memory only: a restart still loses a write that failed before it |
| Per-message index written before the event | `tailer-host.ts` `catchUpPerMessageDir()` | **Confirmed, open** |
| JSONL: a swallowed write failure may still advance the sidecar | `tailer-host.ts` `catchUpJsonl()` / `processUnit()` | Reported, **not yet verified** |
| Pause still appends raw AI bytes to the sidecar | `tailer-host.ts` `catchUpJsonl()` | **Confirmed, open**. Deliberate in the code (`capture_gap` says "Raw data preserved in sidecar"); §3 reverses it |
| PowerShell: the last command's output is kept as first seen while still growing | `powershell-transcript.ts` | **Confirmed, open** |
| Shell relay keeps 8 MiB per stream | `hooks/shell-common.sh` `_REDLOG_MAX_BYTES` | Known limit, labelled `truncated`; streaming to disk proposed (§4) |
| `.cast` stops at 50 MiB | `config.ts` `maxCastBytes` | Known limit, writes a truncation marker; segment rotation proposed |
| Connection monitor, CDP and file watcher swallow runtime errors | the three services | Reported, not yet verified |
| Out-of-scope sanitising skips headers, cookies, URLs | `scope-sanitize.ts` | Reported, not yet verified |
| Targets counts events as "commands"; Scope says "all commands in scope"; ScopeStatus can spin forever on a failed read | `TargetView.tsx`, `ScopeStatus.tsx` | Reported, not yet verified |
