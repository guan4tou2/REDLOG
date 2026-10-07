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

### Cleanup

- [ ] Uninstall or disable has a path.
- [ ] A source RedLog cannot uninstall carries removal steps.
- [ ] Uninstall leaves nothing behind — no empty file, no directory that was
      not there before.

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
