# Timeline I/O visibility

**Design note — proposed, not implemented.** Status as of v0.9.3.

## 1. The problem

> "I can't tell what I typed and what came back."

The timeline answers *when did something happen* very well. It answers
*what did it produce* inconsistently — well for `redlog-run`-wrapped commands
and agent turns, badly for the built-in terminal, and not at all for the
default shell hook. Worse, the three cases look identical on the track: a
9 px dot with no indication of whether output exists, is one click away, or
was never captured.

For an evidence tool this is not only an ergonomics problem. An operator
reviewing a bundle six weeks later cannot distinguish "this command produced
nothing" from "we never recorded what it produced".

## 2. Current coverage

| Source | Input recorded | Output recorded | Cap | Where the operator sees it |
|---|---|---|---|---|
| shell preexec (default) | `command` | **none** | — | `CommandEndDetail` shows exit_code / duration / cwd only |
| shell + `redlog-run` prefix | `command` | `stdout` + `stderr`, split | 100 KB each | `CommandEndDetail`, both streams open by default |
| built-in terminal | `command` | in the session `.cast`, **not** in the event | 50 MB/session | only after clicking ▶ Replay stdout → IPC → cast slice |
| built-in terminal (session) | — | full pty stream | 50 MB | ▶ Replay entire session → xterm player |
| `agent.tool_call` | `tool_input` (parsed JSON) | — | 100 KB | `AgentTurnDetail` |
| `agent.tool_result` | — | `output` | 100 KB | `AgentTurnDetail` |
| `agent.user_message` / `assistant_message` | `full` | `full` | 100 KB | `AgentTurnDetail`, open by default |
| mitmproxy `scanner` | `body_json` / `body_form` / `body_raw` | status, size, duration, body preview | 2 KB (`REDLOG_MAX_BODY`) | **no dedicated detail component** — raw JSON toggle only |
| `browser` console | — | `message` + stack | 2 KB / 100 lines | no dedicated detail component |
| `clipboard` | — | sha256 + length (preview opt-in) | 120 chars | raw JSON toggle |

`CollapsibleStream` (`Timeline.tsx:3065`) is the good part of this picture:
byte count, truncation badge, 4 KB inline preview with a "copy full" escape
hatch, colour-coded per stream. The problem is what never reaches it.

## 3. Gaps

**G1 — the default path has no output at all.** An operator who types
`nmap -sV 10.0.0.5` in a hooked external shell gets a command string and an
exit code. Capturing output requires knowing about `redlog-run` and
remembering to prefix every command, which contradicts the zero-friction
premise. This is the single largest hole.

**G2 — built-in terminal output is two clicks and one IPC round-trip away**,
and nothing on the track hints it exists. The data is already on disk; the
UI simply does not surface it until asked.

**G3 — the dot carries no I/O information.** Not whether output exists, not
its size, not whether `exit_code != 0`. Two commands, one that printed 40 KB
of credentials and one that printed nothing, are pixel-identical.

**G4 — input and output live in separate events.** `command_start` /
`command_end` and `tool_call` / `tool_result` are correctly modelled as
separate chain entries, but the UI never pairs them. `collapseCommandPairs`
hides the start; `_causes` chips can navigate between a tool call and its
result, but there is no side-by-side view.

**G5 — there is no review mode.** The timeline is a *forensic* view: lanes,
clusters, causality, integrity badges. Reconstructing a working session means
clicking dots one at a time. What is missing is a *narrative* view — a
scrollable transcript of input → output in order.

**G6 — `scanner` and `browser` events have no detail component.** HTTP
request/response bodies are captured and then only reachable through the raw
JSON toggle, which shows redaction-masked, unformatted text in a 120 px box.

**G7 — three different truncation contracts.** 100 KB inline (redlog-run and
agent), 2 KB inline (mitmproxy, browser), unbounded-on-disk (`.cast`). Each
signals truncation differently, or not at all.

## 4. Constraint: output must not go into the chain

v0.6.47 reverted in-chain stdout capture, for two reasons that still hold:

- TUI programs blow through any byte cap in seconds.
- ANSI escape sequences make the stored bytes unreadable, and they change the
  canonical hash input for content that is essentially a rendering artifact.

Any proposal here must keep the chain event small and clean. The `.cast`
model is the right one: **bytes on disk, hash in the chain**. The mistake was
not extending that model to every source and not surfacing it in the UI.

## 5. Proposal

### T1 — unified I/O sidecar (`io_ref`)

One storage mechanism for all captured output, replacing four ad-hoc ones.

Output bytes append to `<projectDir>/io/<yyyymmdd>-<n>.iolog` (append-only,
same discipline as `agent-transcripts/`). The event carries only a reference:

```jsonc
"io": {
  "stdout": { "ref": "20260808-3.iolog", "off": 918274, "len": 40213,
              "sha256": "…", "truncated": false },
  "stderr": { "ref": "20260808-3.iolog", "off": 958487, "len": 0,
              "sha256": "…", "truncated": false }
}
```

Properties:

- Chain events stay small and ANSI-free; the sha256 is what gets signed and
  anchored, so the bytes are still tamper-evident.
- One IPC (`io:read(ref, off, len)`) serves every source, replacing the
  cast-slice-only path.
- `bundle-export` copies `io/` alongside `casts/` and lists per-file sha256
  in the manifest; `redlog-verify.py` gains an `io` check.
- Retention prunes `io/` on the same schedule as casts, emitting
  `system.io_pruned` so a missing reference is explained rather than silent.
- Migration is additive: existing inline `stdout` / `stderr` / `output`
  fields keep rendering through the same component. No re-hashing.

### T2 — close G1 and G2

**Built-in terminal (free — the data already exists).** On `command_end`,
compute the cast byte window for that command and stamp
`io.stdout = { ref: <cast>, off, len, sha256 }`. No new capture, no new
storage; it converts a two-click replay into a first-class output field that
`CollapsibleStream` renders inline like `redlog-run` does today. This is the
highest value-per-line change in this document.

**External shells.** POSIX cannot cleanly intercept a stream between
`preexec` and `precmd`, so full parity is not achievable through the hook
alone. Three honest steps instead:

1. Make `redlog-run` discoverable — document it in the capture-health card
   ("external shell: commands captured, output not") rather than only in a
   comment inside the hook script.
2. Offer an opt-in `script(1)`-based session recorder for external shells
   that produces a `.cast`-equivalent, reusing the same `io_ref` plumbing.
3. **Mark the absence.** A `command_end` with no `io` and
   `source != 'builtin-terminal'` renders an explicit
   "output not captured (external shell)" row, not an empty panel. The
   difference between *no output* and *no capture* must be visible — the same
   principle as `recording_paused` explaining a gap in the track.

### T3 — encode I/O on the dot

Small additions to the existing dot renderer, no new layout:

| Signal | Encoding |
|---|---|
| output present | a 3 px notch on the dot's lower-right |
| output truncated | the notch renders amber |
| output not captured | hollow dot (ring only, no fill) |
| `exit_code != 0` | 1.5 px red outline |
| output size | notch width steps at 1 KB / 100 KB (three steps, not a gradient) |

This deliberately reuses the marker-severity work proposed in the audit (V3)
rather than inventing a second visual language: outline = something went
wrong, fill = something was captured.

### T4 — exchange view in the detail panel

When the selected event has a paired counterpart via `_causes` (`tool_call` ↔
`tool_result`, `command_start` ↔ `command_end`), render both halves in one
panel: input on top, output below, with the metadata grid spanning both.
Selecting either member shows the same exchange. This is presentation only —
the two chain rows stay separate.

### T5 — transcript view (new sidebar entry)

The timeline stays what it is. Add a second reading of the same data,
vertically scrolling, one exchange per block:

```
14:22:07  operator@kali   $ nmap -sV 10.0.0.5
                          ├ stdout  4.2 KB  ▾
                          └ exit 0 · 12.4s

14:22:31  claude-code     ▸ Bash: curl -s http://10.0.0.5/api/users
                          ├ tool_input  {...}
                          └ output  18 KB  ▾   ⚑ loot: 2 matches

14:23:02  mitmproxy       ⇢ GET /api/users → 200  18 KB  ▾
```

- Same event store, same filters (lane chips, `/` query, focus chain), same
  redaction masking and reveal auditing.
- Streams collapsed by default with byte counts; expand renders through
  `CollapsibleStream`.
- Loot, scope violations and integrity badges appear inline on the block they
  belong to.
- Exports to Markdown for the report the operator writes downstream —
  which is the one report-adjacent thing RedLog can offer without becoming a
  reporting tool, because it is a verbatim transcript, not an assessment.

T5 is what actually answers the original complaint. T1–T4 are what make it
possible and make the timeline itself honest in the meantime.

### T6 — detail components for the remaining sources

`ScannerDetail` (request line, headers, body; response status, headers, body,
duration) and `BrowserConsoleDetail` (level, message, stack) built on
`CollapsibleStream` + `MetadataGrid`, matching `CommandEndDetail` and
`AgentTurnDetail`. Raise `REDLOG_MAX_BODY` once bodies live in the sidecar
rather than inline in the event.

## 6. Non-goals

- No raw bytes in the chain. See §4.
- No diffing, no assessment, no severity inference from output content. The
  transcript view shows what happened; interpretation is downstream.
- No streaming replay in the transcript view — that is what the session
  player is for.
- No change to `agent_type` values, lane routing or the event envelope. All
  of the above is additive `data` keys plus renderer work.

## 7. Sequencing

| Step | Scope | Depends on |
|---|---|---|
| 1 | T2 built-in terminal `io.stdout` stamping | — |
| 2 | T3 dot encoding + "output not captured" row | 1 |
| 3 | T1 `io_ref` sidecar + `io:read` IPC + bundle/retention/verifier | — |
| 4 | T6 scanner / browser detail components | 3 |
| 5 | T4 exchange view | 1 |
| 6 | T5 transcript view + Markdown export | 3, 4, 5 |
