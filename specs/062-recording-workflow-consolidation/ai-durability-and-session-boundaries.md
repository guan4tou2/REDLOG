# AI capture durability, privacy and package lifecycle — 2026-10-24

Status: implementation in progress. Follows the user-approved capture-trust direction in PR #439 (read-only reference, not merged here).

## Observable requirements (Specify / Clarify)

- A failed event/raw-copy/checkpoint write cannot mark an AI unit consumed. Retrying or reopening preserves committed events without duplication and can recover the failed unit.
- Pause saves no new AI original content, including sidecars. Resume skips everything present at the resume boundary, including writes whose watcher notification was delayed. A line crossing the boundary is discarded. Store only gap metadata; no paused text.
- Per-message files follow the same write-success rule. Supplemental provider streams must respect pause and individual-session exclusion.
- Source authorization remains installation + explicit project permission + allowed cwd. Exclusion is provider/project/session-specific. Missing cwd remains refused; no semantic classifier, no claim that authorized cwd makes every tool read private-safe.
- Existing source rows show observed sessions and allow stopping one session. Explicit reauthorization starts from now; old excluded content cannot be replayed. No new page.
- An app-supplied package update is recoverable in-app; modified/foreign files remain refused and preserved. A fresh install/update does not itself authorize project capture.

## Plan / invariants

The host owns durable progress, transition boundaries and session gates. Provider parsers cannot advance host progress. Separate the source offset from saved-sidecar length, since intentionally omitted ranges cannot be derived from evidence bytes. Checkpoints carry offsets/dispositions, never raw conversation text. Commit complete units after successful processing and raw append; rollback partial raw appends on failure. Preserve independent DB UUID deduplication for event-success/raw-copy-failure retries.

Project source config owns excluded session IDs and per-session activation boundaries, passed to the canonical host. Renderer uses the same source lifecycle and config save path. Unknown provider files, directories and extra content are not overwritten/deleted by package repair.

## Checklist / Analyze

Constitution: evidence integrity, explicit failure, truthful health, privacy omissions with provenance, canonical policy and restrained architecture apply. Tests must distinguish source offset from retained bytes, DB failure from append failure, pause from filtering, and installation from authorization. No PowerShell redesign, provider model invocation, hidden-reasoning capture promise, new navigation or external communication.

Dependency order: failure regressions → host commits/pause → session gates/UI → managed update lifecycle → integration/native validation → verification/domain updates. Cross-platform and live vendor-version acceptance remain separate. T068–T071 in tasks.md track this bounded increment.


## Findings and implementation

- Fault injection reproduced silent JSONL progress after a failed event write,
  per-message index-before-event, paused raw retention/replay, partial-unit
  acknowledgement and new-session discovery after resume. DB-success/raw-failure
  retry also exposed the old seed query using RedLog envelope session_id; it
  now uses the AI session ID in data while retaining one project-wide scan.
- Raw files remain append-only across source shrink/reset. Independent atomic
  checkpoints carry committed source offset and saved byte count; retries trim
  only uncommitted append residue. Complete newline-delimited UTF-8 units are
  decoded; incomplete lines stay at source and parse/write failures do not
  advance progress. Changed per-message files are reconsidered. Provider parsers
  cannot acknowledge host progress.
- Project recording-boundary metadata handles sessions discovered after resume
  and a restart from persisted pause. Existing bytes and cross-boundary units
  are omitted. Same-millisecond timestamp ambiguity is handled conservatively
  on the omitted side. Per-message omission indexes hold filenames/dispositions,
  never paused message bodies. Auxiliary file reads respect pause/session gates.
- Gap metadata describes omissions. Missing parent after a privacy boundary
  does not block subsequent turns or invent a cause. Pending children survive
  ordinary restart through a retained-raw replay offset. No conversation text
  is copied into checkpoints.
- Real Claude Code 2.1.310 serializer tests (local fake API only) initially
  failed: source directories not yet created were not watched, and ignored
  attachment metadata UUIDs held later assistant/tool events in the pending
  parent queue. The watcher now follows only the authorized subtree through
  existing ancestors and canonical paths. Claude returns ignored parent
  metadata to the host; child relations traverse it to a real recorded ancestor
  and retain transcript_parent_uuid. Both new/existing directory journeys pass.
- Existing AI source rows expose an expandable Conversations list. Exclusions
  persist per provider/project; explicit Record new content establishes a new
  session boundary, bounded below by the source activation. The source remains
  enabled so another conversation continues recording. A short authorization
  warning states that tool content from outside the chosen cwd is included.
- Machine installation records distinguish intact managed older packages from
  modified files. Update only copies current app-supplied code; stale packages
  cannot execute. A failed installation-record commit rolls the old package
  back. Receipt/project grants remain unchanged on update; reinstall gets a
  new receipt. This adds no compatibility shim for old development receipts.

## Acceptance checklist

- [x] Event write failure leaves the unit retryable across restart.
- [x] Raw append and checkpoint failures retain committed bytes and dedup events.
- [x] Per-message DB/index/partial-file cases retry instead of disappearing.
- [x] Pause omits raw content, including partial lines and delayed new sessions.
- [x] Persisted pause skips original bytes on reopening; gap contains no prompt.
- [x] Ignored metadata and ordinary pending parents preserve real provenance.
- [x] Per-session stop survives reload, another session continues, reallow starts now.
- [x] Managed update, tamper refusal, rollback and receipt preservation have tests.
- [ ] Final full/package/native evidence recorded below at closeout.

These are bounded contracts. A cwd whitelist cannot detect private prompts or
private tool-read content inside an authorized session; no semantic classifier
was added. Images/hidden reasoning/all vendor versions/Windows/Linux/IDE client
variants are not certified by a single local CLI serializer test.
