# #290 inventory: when each source sends and saves

**Date**: 2026-10-31 · **Base**: `main@5e2533b8` · **Issue**: [#290](https://github.com/guan4tou2/REDLOG/issues/290), first checklist item

Each row says **when the bytes leave the producer** and **when they land on disk**, and puts the source in one class:

- **Continuous**: bounded segments are saved while the source is still running.
- **On completion**: nothing is saved until the response, command or session ends.
- **Unsupported**: not captured, or captured with no lifecycle.

The evidence column names a test that asserts the behaviour, or an observation from a run. A code citation alone is marked *read*: it was read in the code but not run.

## HTTP family: `hooks/mitmproxy-addon.py` through the app's own mitmdump

Common to every row:

- **Send.** `_send_to_redlog` takes one of 64 slots (`BoundedSemaphore(64)`). Four workers POST to `127.0.0.1:<port>/api/events`, with the port and token pinned at send time.
- **Queue full.** A content-free `capture_gap` (`queue-full`) is spooled (#460).
- **Network error or 5xx.** A content-free `capture_gap` (`delivery-unconfirmed`) is spooled. The content is never resent, by design (#291).
- **Landing.** The API ingests each event into `events_logged`, with `timestamp` as the source time and `created_at` as the receive time. A body over 4,096 characters goes to `http-bodies/<sha256>.body`, written to a temp file before it is published.

| Source | Sent | Saved | Class | Evidence |
|---|---|---|---|---|
| Request, response, large body, slow non-SSE response | Once, from the `request` / `response` hook, after mitmproxy has buffered the whole body. `stream_large_bodies` is not set | One event per side. The body is capped at `MAX_BODY` (10 MiB) with `truncated` set | On completion | Soak 2026-10-31: `/slow` (20 s trickle) was saved only as one `http_response`; `/large` 16 MiB was saved as 10 MiB `truncated` |
| SSE (`text/event-stream`) | Each network chunk is cut into parts of 64 KiB or less, as `http_response_chunk {flow_id, seq, offset, source_timestamp}`, from `flow.response.stream` | Per part, before EOF | Continuous | `test/mitm-sse.test.ts`; `e2e/sse-preservation.spec.ts` (saved before EOF; pause leaves a seq gap; upstream death is recorded as `interrupted`) |
| WebSocket (text and binary, both directions) | One `ws_message` per reassembled message, from the `websocket_message` hook | Per message | Continuous | `e2e/sse-preservation.spec.ts` (saved before close; binary bytes survive into HAR; `terminate()` is recorded as `interrupted`) |
| WebSocket close | `websocket_end` with `stream_state`, `message_count_observed` and `stream_not_queued_bytes` | Once | — | same |
| Raw TCP | One `tcp_message` per message | Per message | Continuous content, **unsupported lifecycle**: there is no `tcp_end` / error hook | *read*: `tcp_start`/`tcp_message` only. With mitmproxy 12.2.3 a peer's RST reaches the addon as an ordinary close with no error (`e2e/tcp-lifecycle.spec.ts`, 2026-10-31) |
| Upstream error or disconnect | `http_error`; for a stream, `stream_state: interrupted` | Once | — | `e2e/sse-preservation.spec.ts`; soak: `/disconnect` gave one `http_error` |
| Producer killed (`taskkill /F`, SIGKILL) | Nothing more. `done()` never runs, and up to 64 in-flight events are lost with no record (#291) | Saved prefix stays | — | Soak 2026-10-31 (below); #469 |

**Reading back** (#469). `streamCompletion` derives `end-observed`, `known-partial` or `completion-unknown` from the saved rows. A retried chunk is counted once (`DISTINCT seq`).

## Terminal: built-in PTY cast

| Source | Written | Saved | Class | Evidence |
|---|---|---|---|---|
| Built-in pane output | Each `term.onData` becomes one frame, written with `fs.writeSync`. There is no fsync | Rotates to `<id>.partNNNNNN.cast` at 50 MiB per part. Every part is playable on its own. A part's hash is fixed when the part closes | Continuous | `test/terminal-recording.test.ts` (parts, ranges, >50 MiB, partial write failure) |
| Resize | `'r'` frame in the same stream | same | Continuous | `test/cast-slice.test.ts` |
| Pause | No frame is written while paused. The pause is visible only through the pause/resume events | — | — | `test/terminal-cast-state.test.ts`, `e2e/recording-pause.spec.ts` |
| Close | `session_end` with `castSegments [{path, bytes, sha256}]`, `castSha256`, `castBytes` and `reason` | Once | — | `test/terminal-recording.test.ts` |
| App crash mid-session | `recoverOrphanSessions` writes `session_end {recovered: true, castSha256: null}` on the next start | Parts on disk survive | **Gap**: the recovered end lists no parts, no bytes and no last frame time. Commands still open get no boundary | *read*: `terminal-manager.ts:432-480` |

## Terminal: external shells (`redlog-relay.py`, hooks)

| Source | Sent | Saved | Class | Evidence |
|---|---|---|---|---|
| Command output, short command | Held in memory, then sent inside `command_end` | Once | On completion | `test/relay-late-output.test.ts` |
| Command output after 16 KiB or 1 s | `command_output` chunks of 16 KiB or about 1 s, cut on line boundaries, each with `command_id`, `seq` and `source_timestamp` | Per chunk | Continuous | `test/relay-late-output.test.ts` (output past the old cap is segmented; paused bytes are counted) |
| App down | Hook events are spooled to `~/.redlog/pending`, up to 5,000 files. Relay chunks are posted directly and dropped, and counted in `dropped_bytes` on `final` | — | — | `test/shell-spool-cap.test.ts`, `test/spool-replay.test.ts` |
| Shell killed mid-command | No `command_end`, because it comes from the next prompt. The relay sends its `final` | — | **Gap**: the command is never closed | *read*: `shell-bash-hook.sh:395-427` |
| `redlog-session.py` | `session_output {sequence, terminalId}` per read | Per read | Continuous, best effort | *read* |
| PowerShell (`shell-hook.ps1`, transcript) | `Redlog-Run` files of up to 100 KB; the transcript is re-read per command | Per command | On completion | *read* |

## Observed: 1-minute soak, 2026-10-31

**Setup**: Windows 11 (10.0.26300), mitmdump 12.2.3 (Python 3.12.13), source build at `main@5e2533b8`, run through `e2e/stream-soak.spec.ts`. The traffic was SSE at 1/s, WS pushes of 4 KiB at 1/s, and client text every 2 s.

**Before the kill**:

- 57 SSE chunks saved (33,204 bytes received by the client)
- 125 WS messages saved (34 client, 91 server)

**After the hard kill (`taskkill /F /T`)**:

- Both flows read `completion-unknown`.
- After an app restart: 57 chunks and 125 messages, with no seq gaps and no duplicates.
- The exported HAR's SSE bytes are a byte-exact prefix of what the client received (33,204 of 33,204).
- App and mitmdump memory were flat over the minute: App −24.6 MiB, mitmdump −1.2 MiB.

## Observed: WebSocket memory, 5 minutes, 2026-10-31

Same host. WS pushes of 64 KiB every 100 ms, plus the SSE and client traffic above. The budget was 64 MiB of growth after warm-up.

| Addon | mitmdump at warm-up → end | Growth | Read back after kill and restart |
|---|---|---|---|
| `main@5e2533b8` (`4755ad9d…`) | 129.8 → 305.0 MiB | **+175.2 MiB**, rising linearly | 281 SSE chunks, 2,849 WS messages |
| Bounded history (`038e593f…`) | 110.1 → 110.9 MiB | +0.8 MiB | 284 SSE chunks, 2,871 WS messages: no gaps, no duplicates |

On `main`, mitmproxy keeps every relayed message on the flow, so mitmdump grows with the bytes the WebSocket has carried. An hours-long stream ends where the host runs out of memory.

## Gaps and the order they are taken

Each item is a separate PR against `main` (Refs #290). Every PR adds a RED test first.

1. **Inventory and harness** (this file). The local stream sources are `e2e/stream-sources.ts`: large body, slow response, SSE, bidirectional WS, binary frames and disconnect. The opt-in soaks with a budget fixed beforehand are `e2e/stream-soak.spec.ts` and, for PTY, `e2e/terminal-soak.spec.ts`. Results are in [verification.md](verification.md).
2. **WS/TCP memory**, #479 (merged). mitmproxy keeps every WebSocket/TCP message for the life of the flow, so an hours-long stream grows mitmdump without bound (measured above). `message_count` is that list's length.
3. **Known total of a truncated body**, #480 (merged). A body over `MAX_BODY` goes to the sidecar with `size` set to the stored bytes. The producer's known total is dropped, so the record says "10 MiB" where it should say "10 of 16 MiB". Observed in the soak: `/large` 16 MiB was saved as `size: 10485760, truncated: true`.
4. **TCP lifecycle**, #481 (merged). A TCP stream had no end or interruption event.
5. **PTY crash recovery**, #482 (merged, through #483). A recovered `session_end` should list the parts actually on disk, with their bytes and hashes computed at recovery and marked as such. Commands still open should be closed as interrupted.
6. **Disclosure after the fact**, #483 (merged). An ended terminal tab showed only `[process exited]`, and the export preview had no row for partial or recovered casts.

Not taken here:

- **Undelivered segments are lost.** They are never resent after a producer kill: the spool deliberately holds no content (#291 owns that contract).
- **Non-SSE streaming bodies are saved on completion only.** This covers NDJSON, long-poll and chunked downloads. Streaming every response would change mitmproxy's buffering for all traffic, and is a product decision.
- **No SMB/RDP parser.**
