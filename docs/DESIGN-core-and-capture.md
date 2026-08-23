# Core purpose and capture coverage — 2026-08-21

Outcome of a design review that started from "what is this project actually
for" and ended up revising the core. **This note contradicts
`PRODUCT-POSITIONING.md` on one load-bearing point** (see §1) — that document
declares itself the tie-breaker, so it needs updating before it misleads the
next reader. Everything below is agreed; the positioning rewrite is not yet
done.

---

## 1. The core, restated

> RedLog records **what actually happened** during a red-team engagement —
> every command, connection, file and screen, whoever or whatever produced it —
> so that afterwards you can replay it, hand a purple team something they can
> judge traffic from, and, above all, **find evidence of the things you were
> not watching when they happened.**

The everyday consumer of all this is **the operator themselves, writing the
engagement up a day later** — not the purple team and not a lawyer. Writing a
report means going back for the screenshot of a finding and the exact command
with its output. That is the trip every captured thing has to survive, and it
is why the output-capture gaps below (§2.3, §2.4) matter more than their size
suggests: a command without its output is not evidence of anything.

The third clause is the motive, and it is general. Work happens that you did
not see: a scan running for four minutes, a background process, a teammate's
session on the shared VPS, a command whose output scrolled past. Later you
need to find out, and the evidence has to be there.

**An AI agent is one producer among several, not half the picture.** It is the
sharpest instance of the problem — you delegate, it does three hundred things,
you know none of them — which is why it gets a summary card (§4b) and why the
transcript tailer exists. But the same gap opens without an agent anywhere
near it, and the model treats agents as one `agent_type` among eighteen
lanes, which is correct. Earlier drafts of this note put "people and AI
agents" in the core sentence; that over-weighted one source.

### What changed

`PRODUCT-POSITIONING.md` builds everything on tamper-evidence — "what
separates RedLog from a scratchpad" — with the evidence consumer (S1, who
"never opens the app") as the ultimate stakeholder.

**Tamper-evidence is demoted to an incidental guarantee.** The hash chain,
OpenTimestamps anchoring, operator signing, the signed bundle and the verifier
all keep working. They stop being the design centre, and they stop earning
prominent UI.

The load-bearing property is no longer *defensibility* but **knowability**:
completeness still matters, and matters more than ever, but it serves "so you
can find out what happened" rather than "so it survives a legal challenge".

### What this does to the wedge

The old wedge was local + passive + tamper-evident + AI-native. Drop the third
term (demoted) and demote the fourth (agents are one source, not the
definition), and what is left is **capture at the point of work, locally,
readable afterwards**. The nearest neighbour becomes RedEye rather than
Ghostwriter, and the distinction holds:

> RedEye parses C2 logs after the fact — the residue of someone else's system.
> RedLog captures at the shell and the agent as it happens, so it holds things
> a C2 log never contains: which file the agent read, which command it ran,
> what came back.

### Consequences for existing conclusions

Several earlier judgements were built on the old core and invert:

- **Compressing idle gaps** is no longer a contradiction. "A 20-minute gap is
  *right*" belongs to the completeness-for-defensibility framing. For
  after-action review, nobody wants to scroll through 20 idle minutes of an
  eight-hour engagement. Gap compression is a core convenience.
- **A reading posture in the app** is core, not scope creep. The earlier
  argument against it rested on S1 never opening the app; S1 is no longer the
  ultimate stakeholder, and the reviewer is the operator.
  (The *audit mode* shape — chained-only + UTC + locked — still does not hold,
  because all three ingredients are tamper-evidence concerns.)
- **Timeline size** is justified investment. The timeline is the product.
- **Search is core.** "Being able to find the evidence later" *is* search.

## 2. Capture coverage — four gaps

Nine sources exist: shell-hook, agent-tailer, builtin-terminal, mitmproxy,
browser-console, screenshot, clipboard, file-watcher, process-monitor.
Measured against "come back to the timeline and see what was done at that
moment", four gaps. All four are to be closed.

### 2.1 Non-HTTP traffic

mitmproxy only sees what is proxied. Scanning, SMB, LDAP, RDP, reverse shells
and C2 beacons produce none of it. A timeline can show `nmap -sV 10.10.11.24`
and then nothing about what it did.

**Decision: connection-level first, pcap later.** Connection-level records who
connected to which `IP:port`, over what protocol, for how long — no payload,
no root, and it maps onto the existing `pivot` detection which already watches
connections.

**Known limitation, to be surfaced honestly in the UI.** `nmap -sS` never
completes a handshake, so socket-table polling cannot see it. Connection-level
capture covers *established* connections — reverse shells, beacons, sessions,
transfers — and structurally misses SYN scans. The command is recorded; the
packets it produced are not, and the timeline must say so rather than imply
coverage.

**pcap is complementary, not a replacement.** It sees TLS as opaque bytes;
mitmproxy terminates TLS and sees plaintext. The "HTTP exchange" column of the
purple-team export can only come from mitmproxy.

Cost of adding pcap later — architecturally cheap, operationally not:

| | |
|---|---|
| Event model | Free. `io: { stream: 'cast', ref, off, len }` already discriminates on `stream`; `stream: 'pcap'` slots in, and `retention.ts` already sweeps large artifacts and writes `system.*_pruned`. |
| Lane | Free. `scanner` already exists and is documented as an open agent_type for scan output. |
| Privileges | Root / `CAP_NET_RAW`. Runs straight into positioning risk #1 (first-run friction). |
| Windows | npcap — a driver install, and antivirus will have opinions. |
| Redaction | The four-layer model handles text fields. Credentials inside binary protocol payloads are a different problem, and payloads in a bundle carry client data. |
| Readiness model | Needs a fourth state (below). |

### 2.2 Commands on remote hosts

Smaller than it looks. `terminal-manager.ts` records the **entire PTY byte
stream** to the `.cast`, so everything typed inside an `ssh` or `ligolo`
session, and everything that came back, is already recorded. What is missing
is the structured `command_start` / `command_end` pair, because the shell hook
is not running on the remote host.

So the gap is not "no evidence" but "evidence that cannot be queried".

**Decision: (a) *and* (b) + (c), split by who owns the host.**

`hooks/vps-deploy.sh` already deploys the hook to a remote box and tunnels
events back over `ssh -R`, through the same code path as the local hook, with
the envelope's `hostname` distinguishing origin. That is the right answer for
infrastructure **you** own — your VPS, a redirector, a team jump box — and it
yields complete structured events.

It is the wrong answer for a **target** host: writing a hook onto a machine
you are assessing is an OPSEC footprint and, under many rules of engagement,
not permitted. There, parse the local PTY stream and mark what was parsed.

The earlier objection to hook deployment ("writing to a target host") only
ever applied to half the cases.

No new concept is needed: `data.source` already carries provenance
(`builtin-terminal`, `shell`, `file-watcher`, `http`, …), so a parsed command
is `source: 'pty-parsed'`. The UI already has a vocabulary for "this row is a
different grade of evidence" — the tier glyph.

**Hard constraint: prefer a miss to a mistake.** A parse error does not
produce a gap, it produces a *fabrication* — a command on the timeline that
the operator never typed, which is worse than its absence, because this
product's foundation is that the record can be trusted. The parser stays
conservative: only unambiguous shell prompts, and never guess inside
multi-line input, pasted blocks, or full-screen TUI programs (vim, less).
Where it cannot tell, it emits nothing and the recording still holds the
bytes.

Pairs with making `.cast` recordings full-text searchable, so an unstructured
remote session is still findable.

### 2.3 Windows is thin

More specific than "thin": `shell-hook.ps1` captures command, exit code and
duration automatically, but **output only if the operator prefixes the command
with `Redlog-Run`** — PowerShell cannot cleanly split stdout/stderr from a
post-command hook. Remembering a prefix is note-taking discipline, which is
the exact thing §1's second half exists to remove. macOS and Linux capture
output automatically.

**Decision: PowerShell `Start-Transcript` plus a tailer.** Same shape as the
agent tailer — something else writes a file, we follow it — so it reuses
`tailer-host.ts` rather than adding a mechanism.

Rejected: script-block logging (4104 events) captures the most, including
deobfuscated payloads, but needs administrator rights and a group-policy
change, which lands straight on positioning risk #1. Also rejected:
auto-wrapping every command in `Redlog-Run`, which changes how commands
execute (stream redirection) and would break interactive tools.

`process-monitor` polling still misses short-lived processes. Open.

### 2.4 Tool output is replayable but not queryable

**Decision: full-text search over recordings, plus keep the artifacts. No
parsers.**

`.cast` recordings become full-text searchable, and `file-watcher` keeps the
tool's own output files (`nmap.xml` and friends) with their SHA-256.

This answers "where is the output of that scan" and "which runs mention 445".
It does not answer "list every open port", and that is the correct place to
stop: parsing nmap XML into structured findings is *interpretation*, the same
shape as the opinionated ATT&CK tagging the positioning lists as a non-goal.
What counts as a finding is per-shop opinion; what was on screen is not.

Full-text search over `.cast` closes two gaps at once — it is also what makes
an unstructured remote session (§2.2) findable — which makes it the
highest-leverage single capability in this note.

**Built 2026-08-22** (`src/core/cast-index.ts`). Three decisions worth
recording, because each had a plausible alternative:

*A separate database file, not a table in `events.db`.* The index is derived,
mutable and rebuildable; the evidence DB is none of those, carries
append-only triggers, and is copied verbatim into evidence bundles. The
deciding argument was retention: recordings are swept after N days, and text
surviving in an index inside the evidence DB would make the retention policy
a lie — the operator is told the recording aged out while its contents stay
searchable. `retention.ts` now calls `pruneCast`, and a test in
`test/retention.test.ts` fails if that link is ever cut.

*Token search, not trigram.* Trigram gives grep semantics, which is what an
operator reaching for this expects, at roughly 3x the indexed text on disk.
Across an engagement of 50 MB recordings that is the difference between an
index that ships and one that fills the disk. unicode61 with prefix indexes
covers what operators actually type — an IP, a port, a hostname, a tool name
— because those are token-initial. The UI states the limit rather than
letting a miss read as absent bytes.

*The index status is surfaced, not hidden.* A project whose recordings are
still being read returns fewer hits than it will in a minute. For this
product that is the one failure mode that must never be silent, so the search
view says how many recordings are still pending — including on the "no
results" screen, which is exactly where a silent partial index would do its
damage.

## 3. Point and span

Not a new model — the data already carries it and the timeline does not show
it.

- A single connection or command → a **point**.
- A scan or bulk operation (nmap, dirb, gobuster) → a **span** covering its
  duration.
- In both cases **only the command is listed.** The connections it produced
  are its contents, reachable by reference, never rendered individually.

This preserves causality, which capture-time aggregation into a synthetic
"scan activity" event would have destroyed. The command *is* the event.

Already present:

- `_causes` — a first-class link, used by the tier rules ("does it earn keep
  via `_causes` to a chained row?").
- `duration_sec` on `command_end` — a twelve-second command is already a span
  in the data.
- `bands` with `x0`/`x1` in `Timeline.tsx` — the span rendering path exists,
  currently used for terminal session boundaries.

Connections with no parent command — beacon heartbeats, implant callbacks,
GUI-tool traffic — follow:

| | |
|---|---|
| Has a parent command | attach; do not draw separately |
| No parent, instantaneous | point |
| No parent, sustained | span — a reverse shell open from 14:32 to 15:11 is a long line, and that shape is itself the information |

**Open question:** a span crossing a compressed idle gap. Proposal: keep it
continuous but draw the compressed stretch dashed, so length stops implying
elapsed time exactly where the axis stopped being proportional.

## 4. Purple-team export

An **add-on**, not the core. The core is that all of this is recorded in the
first place; the export is a way to hand it over.

Columns: time, source, target, command, HTTP exchange. Across **all** capture
sources, not just AI agents — ordinary red-team work needs command-and-time
logging just as much.

Mostly a projection over what already exists. The envelope carries
`timestamp`, `operator`, `hostname`, `agent_type` and `target_id` on **every**
event, which covers time/source/target uniformly; command and HTTP exchange
are per-lane fields in `data`, correctly so — a DNS query has no command and a
screenshot has no HTTP exchange.

- Formats: JSON and Markdown.
- **Includes full agent input and output.** Markdown collapses it behind
  `<details>`; JSON carries it whole. Both go through the existing export
  redaction boundary. The skeleton alone cannot answer "what did the agent
  actually see", which is the motive in §1.

**Blocker:** the one-line summary of an event exists only in
`Timeline.tsx:111` (`eventTitle`). The main process and the export path have
no equivalent, so a purple teamer would receive raw per-lane JSON. Move
`eventTitle` into `src/core/` so the timeline and the export read one
implementation — the same fix already applied twice this cycle (time
formatting, the shortcut table), both of which had been "identical output, so
nothing looked wrong" right up until they were not.

## 4b. Reviewing a session

A session — an agent's, or a terminal's — is often hundreds of entries, and
scrolling it is not the same as knowing what it did. That is §1's motive
restated as a UI problem, and it is not agent-specific: an eight-hour terminal
session needs the same digest.

**Decision: a structured summary card per session, folding open to the detail.**
Which files were touched, which commands ran, which hosts were reached, how
many failed, how long it lasted.

Every line is an aggregation over fields that already exist. There is no
judgement about *what the session was doing* — an LLM-written précis was
rejected: a wrong summary inside an evidence log is unfalsifiable by the person
reading it, and generating it would send client data to an external API,
against the local-first pillar.

This is a third consumer of the same `GROUP BY` aggregation that host search
and the Targets page need — which is what makes that query worth building
properly.

## 4c. Getting back to a moment in time

An engagement runs for days. The minimap supports drag-to-zoom and
click-to-jump, but there is no way to say "8/19 14:32" — you aim at a density
histogram.

**Decision: a time input, wired into ⌘K, plus day boundaries drawn on the
minimap.** No new view. ⌘K keeps being the jumper; the restored search page is
the explorer.

## 4d. Two lanes with no producer

`credential_use` and `c2_checkin` have no built-in producer — they exist only
for external agents posting to `/api/events`, so by default they are always
empty. "Which credentials did I use where" is one of the questions an
after-action review asks most.

**Decision: give `credential_use` a producer; leave `c2_checkin` external.**
Credential use is derivable from capture that already runs — a key copied to
the clipboard, `-p` / `--password` on a command line, an `Authorization`
header seen by mitmproxy. C2 check-in needs integration with a specific C2
framework, and parsing a C2's logs is RedEye's job by the positioning's own
table.

## 4e. What the chain sampler now means

The background sampler stays, and its badge copy changes. It reads "background
chain sampler detected tampering"; under §1 that is the wrong claim, and it
was usually the wrong claim before — the one real `chain_sample_broken` in the
field (v0.7.5, closed in v0.11.3) turned out to be field *order* in a
reconstructed hash, not an attacker.

What a broken link means now is **"the record does not join up here, so
something may be missing"** — which matters more under knowability than it did
under defensibility, because the operator is relying on that record to find
out what happened. It still raises `Needs attention`.

## 5. Consequences for the readiness model

`computeCaptureReadiness` has three states: `active`, `wired`, `todo`. A
source that needs elevated privileges introduces a fourth: **installed but not
permitted**. It is not `todo` — the operator has done the setup — and it is
not `wired`, because it will never produce an event. Classified as `todo`
today, first-run guidance would keep telling them to install something that is
already installed.

Enabling any source that writes client traffic to disk owes a §5.5-style
disclosure at the moment it is switched on, naming what lands on disk. The
threat model's at-rest disclosure currently assumes text events plus terminal
recordings.

## 6. Still open

- Windows script-block logging (§2.3, rejected). PowerShell Start-Transcript
  following (§2.3, chosen) is **done** — `transcript-tailer.ts` follows the
  transcript the `start-transcript-hook.ps1` writes and parses it back into
  shell command events (`start-transcript.ts`). Queryable tool output (§2.4) is
  **done** — full-text search over `.cast` recordings (`cast-index.ts`).
  Non-HTTP traffic (§2.1) is **done** — connection-level capture
  (`connection-monitor.ts` / `connection-table.ts`).
- Settings: **11 pages / 27 field groups**, against positioning risk #2 which
  named "8 tabs / 34 groups" as the symptom of breadth outrunning the persona.
  The left list took the page count *up* to 13 before removals brought it to 11
  (export and cloud-share pages gone) and the groups from 34 to 26, then back
  to 27 when connection capture added one. Three groups still need a scope
  ruling rather than a merge: the deconfliction webhook, operator tokens, and
  the MCP server.
- Timeline view modes — the audit-mode shape does not survive §1, but the
  eight flat toggles are still a real problem.
- 18 lanes.
- ~~The plugin marketplace, publisher trust and revocation lists.~~
  **Removed 2026-08-22.** Browsing a registry, pinning publishers by Ed25519
  fingerprint, and reading revocation lists are the machinery of *distributing*
  capture code. §1 is about not missing anything and finding it afterwards;
  distribution serves extensibility, which is a different product. Managing
  what is installed stays, because "is anything capturing that I did not put
  there" is a question §1 does have to answer. The `redlog-sign` CLI went with
  it — it existed only to produce registry entries.
- ~~Size-pressure eviction for the body store.~~ **Built 2026-08-22**
  (`body-eviction.ts` + `sweepBodyStore` in `retention.ts`). Time-based
  retention did not bound the store by size; this evicts the coldest UNPINNED
  bodies when it exceeds `httpBodies.maxBytes` (config-only, 0 = unbounded,
  the default). Scope is the pin: an in-scope body is never evicted. The safety
  property is that eviction deletes the `.body` file, never the event — the
  sha256 attestation and the chain survive, and an evicted body reads back as
  "content no longer on disk", not as an erased fact. A `system.body_evicted`
  audit event records each sweep, and if the pinned set alone exceeds the
  budget the shortfall is reported rather than resolved by touching evidence.
- Rewriting `PRODUCT-POSITIONING.md` to match §1.

### The test being applied to Settings

For each field group: **does the operator in §1 have to understand this to
answer "what happened, and can I show it"?** If not, it is either a default
this product should pick, or something that belongs to a different product.

Two rounds so far, worth 4 groups and 1 page between them.

The first removed three groups that were not settings at all — export is an
action, and it now lives in the shell's one export control (§10). That also
emptied the "Retention & export" page down to a screenshot interval, which had
been filed under export while being a capture setting; it moved, and the page
went.

The second removed the marketplace. Only one group, but the group was a
registry browser, a publisher trust editor, and a revocation viewer stacked
inside it — the group count understated it, which is worth noting because the
count is the metric positioning risk #2 uses.

The third went group by group, and two of the five candidates turned out to
be wrong on inspection. Both failures were the same shape — **the name did
not describe the contents**:

*"Polling" is not a tuning knob.* Every field in it decides what RedLog
itself sends to the network and to whom: which resolver or third-party echo
service learns the operator's address, how often, from where. During an
engagement that is OPSEC surface, and it belongs in front of the operator
rather than in a packet capture. It stays, renamed to "What RedLog itself
sends out". The bad name is what nearly deleted it.

*"Team Profile Sync" was one useful button and one duplicate.* Import
duplicated the project picker's, which is where you want it — you seed a
config when creating a project, not after. Export could not go with it:
deleting it would leave an import that consumes files nothing produces, and
it carries `views.json` as well as `config.yaml`, so it is not a button for
`cp`. Kept as one button, renamed "Hand-off profile".

Actually removed or merged: screenshot quality folded into screenshots (one
subject, two groups); VPN adapter detection folded into safe/exposed IPs (it
exists only to answer that group's question); "Check for updates" moved to the
title bar beside the version string it sat next to a copy of.
