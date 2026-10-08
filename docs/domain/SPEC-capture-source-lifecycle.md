# Capture source lifecycle

Every capture source answers the same questions, in the same order, and a
source that skips one of them fails silently — which is the failure mode this
product can least afford.

Two defects motivated writing this down. Neither crashed; both looked healthy.

- **DNS recorded nothing for its entire life.** The mitmproxy addon implemented
  `dns_message`; mitmproxy dispatches `dns_request`, `dns_response` and
  `dns_error`. The proxy resolved and answered queries the whole time, so the
  only symptom was an empty timeline — and an empty DNS timeline reads as *the
  target resolved nothing*, not *this was never switched on*.
- **Exported bundles shipped without their verifier.** The packaged build did
  not carry `tools/redlog-verify.py`, so every bundle from an installed RedLog
  lacked the thing that makes it checkable by a third party.

A capture source is not a feature that works or crashes. It is a claim RedLog
makes to an operator about what is being recorded, and the dangerous state is
the one where the claim is false and nothing says so.

## States

A source moves through these. They are not interchangeable, and the UI must
not collapse them:

```
Unavailable      the machine cannot run it (missing dependency)
Available        it could run here
Configured       installed, or switched on
Running          its process or watcher is alive
Verified         at least one real event from it reached the evidence store
Failed           it tried and could not
Removed          uninstalled, with nothing left behind
```

`Configured` is not `Running`, and `Running` is not `Verified`. Spec 038/039
established that for the shell hook and HTTP capture; it holds for every
source. A proxy that is listening has proved nothing about capture.

### Quiet is not a state

This list used to end `Active / Idle — verified, and currently feeding /
currently quiet`, and the capture model carried that pair until `d6e60e9`.
It was wrong in a way worth recording, because the mistake is easy to make
again.

What `Idle` measured was the **operator**, not the capture. A terminal with
nobody typing in it, a clipboard nobody copied to, a file watcher over a
directory nobody touched — all "idle", none of them a fact about whether
RedLog can record. Worse, it was windowed: ten minutes of not typing moved a
source from green to amber and back with nothing changed, and an indicator
that changes on its own teaches an operator to ignore the one signal that must
never be ignored.

So a source's state answers one question — **can it record** — and the rest is
reported as data beside it:

- `lastEventAt` per source, shown as an age. A quiet source is a quiet source;
  the reader decides what that means.
- A source that was running and stopped delivering is detected by a **liveness
  signal**, never by silence. Silence cannot tell a broken producer from an
  operator at lunch. Today only plugin producers have one (a
  `producer_heartbeat` every 15s); a core source that acquires one may use it
  the same way.
- "Nothing has ever been recorded" is a property of the project, not a fault of
  a source. It is reported (`hasRecorded`), not graded.

A capture source that is set up and has recorded nothing is in exactly the
state a proxy with no traffic is in: working, and waiting for the operator.
Grading that amber is the same lie as a green dot over a dead hook, in the
other direction.

### One source, many terminals

The states above are a source's. Spec 052 added a second axis underneath one of
them, and conflating the two would undo most of this document.

The `terminal` source is `Verified` when any terminal has recorded a command.
But "the terminal source can record" and "**this** terminal is recording" are
different questions, and the operator asks the second one:

```
enrolled / not     this machine's shells load the adapter, or they do not
recording          this terminal is recording right now
stopped            `redlog stop` in this terminal, durably — survives the
                   next prompt, and a subshell, because it is a file
mode auto|manual   what a NEW terminal starts as, machine-wide
project-switched   RedLog moved to another project under this terminal, so it
                   stopped and will not restart (see below)
```

Three rules keep the axes from collapsing into each other:

- **A per-terminal stop is not a source failure.** The `terminal` row stays
  `ready`; what changed is one terminal's answer. Grading the source amber
  because an operator stopped one shell is the same mistake as `Idle`, with a
  different cause.
- **The state is a file, not a variable.** `~/.redlog/terminals/<id>.json`,
  read by the shell at each prompt and by RedLog for the card. Two readers, one
  answer — a terminal that says "stopped" while the card says "recording" is
  worse than either answer alone.
- **A stop is a gap with two ends, not silence.** `capture_stopped` /
  `capture_resumed` bracket it, carrying the terminal and the reason. "No
  events for twenty minutes" reads very differently as *the operator stopped
  recording* than as *the operator was reading*, and a reader a year later
  cannot tell either from nothing at all.

**`project-switched` is the one that cannot be undone from the terminal.** A
terminal is pinned to the project it was opened against; when RedLog opens
another one, the terminal stops and `redlog start` will not restart it. The
failure that prevents is a command from engagement A filed under engagement B
— not a missing command, but a lie in a document a client reads, written by
the tool whose whole job is to be believable. The safe answer is a new
terminal, and it is cheap.

## Checklist

Any change that adds or alters a capture source answers all of these.

### Availability

- [ ] The dependency can be checked, and the check runs on this platform.
- [ ] A missing dependency is never reported as `available`. A source that
      installs cleanly and then records nothing is worse than one that refuses.

### Setup

- [ ] Install or setup can actually be carried out — one click where RedLog
      can do it, otherwise steps with runnable commands.
- [ ] A setup failure names its reason, not just that it failed.
- [ ] A remediation command does not assume a tool the machine may not have.
- [ ] Packaging carries every resource the source needs at runtime, and a
      packaged build was exercised.

### Activation

- [ ] "Process or config is ready" and "capture is verified" are separate
      states with separate wording.

### Verification

- [ ] At least one real event, from the real dependency, is shown reaching the
      evidence store. Not a mock; the actual binary at the actual version.
- [ ] "No events yet" and "this source failed" are distinguishable in the UI.
- [ ] The last event time is observable, so silence can be aged **by the
      reader**. The source does not grade its own silence, and the age does not
      carry a colour — see "Quiet is not a state".

### Coverage

- [ ] The UI says what this source records.
- [ ] The UI says what it does **not** record. Metadata-only capture that
      looks like full capture is the same lie in a quieter form.
- [ ] Where capture is deliberately declined, the **list of what is declined is
      visible to the operator**, not only in the code.

      Spec 052 is the case that forced this line. Terminal capture leaves a
      `native` class of commands completely alone — `nc`, `ncat`, editors and
      pagers — and it is not an oversight: a relayed `nc` costs the operator
      the Ctrl-Z / `stty raw -echo` / `fg` upgrade in the middle of an
      engagement (FR-025), and a relayed `vim` records redraws and none of the
      file (FR-026). Both are the right call and both are invisible from the
      timeline, because what they produce is an *absence*.

      So the class lists are shown in Settings ▸ Hooks and readable with
      `redlog class list`, and each such command is recorded
      `completeness: metadata-only`, `output_disposition: interactive` — the
      row says the body is missing and why, instead of an empty `stdout` that
      reads as "this command printed nothing".
- [ ] Capture that was declined, failed, redirected or stopped are four
      different words in the record, not one empty field. `interactive` is a
      decision, `not-captured` is a failure, `redirected` is the operator's own
      doing, and a stop is bracketed. Collapsing them makes every deliberate
      silence look like a broken capture, and every broken capture look
      deliberate.

### Cleanup

- [ ] Uninstall or disable has a path.
- [ ] A source RedLog cannot uninstall carries removal steps.
- [ ] Uninstall leaves nothing behind — no empty file, no directory that was
      not there before.
- [ ] Where setup edits a file RedLog does not own, **uninstall returns it
      byte-identical**, and a test proves it as an inverse rather than by
      inspection.

      The shell-source install appends a block to the operator's `.zshrc`.
      Uninstall used to replace that block, leading newline included, with a
      single newline — so every install/uninstall cycle left one more blank
      line behind, and a file that had not ended with a newline came back with
      one. Nobody would have noticed, and a red-team tool has no business
      leaving a footprint on the machine it was run from.

### External contract

- [ ] Every external hook, API or event name is verified against the version
      actually installed, by observing it — not by reading documentation that
      may describe another release.
- [ ] A test pins those names, so a rename fails a run instead of quietly
      producing an empty timeline.

## Why the last one matters most

A hook whose name does not match is invisible. No error, no warning, no
degraded mode: the handler is simply never called, and the product reports
that the target did nothing. Everything else on this list produces a symptom
somebody notices. That one produces an absence, and an absence is what this
product exists to rule out.
