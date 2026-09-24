# Feature Specification: Capture Packs — Essential Capture Built In, the Rest as Packs

**Feature Branch**: `spec/capture-packs`
**Created**: 2026-09-24
**Status**: Verified
**Input**: "If the capture that is necessary stays built in, and everything else becomes plugins?" — operator, 2026-09-24.

Capture sources today are spread across nine Settings pages, each with its own
switch, and are listed by capture health from a mix of manifests
(`starter-pack`, `pcap-capture`, `c2-tailers`, `transparent-proxy`) and
hard-coded services. An operator cannot see, in one place, what RedLog records
by default and what they could add.

## Decision on "plugins"

Plugin code can run only as an external script (`capture`) or as a privileged
`tailers` module in the main process; the isolated code host was removed in
Spec 027. Moving in-process services (monitors, tailers, terminal) into
plugin-executed code would rebuild that host without isolation and touch the
evidence path. **This spec therefore keeps the code in core and makes each
optional source part of a bundled pack**, declared by manifest like
`starter-pack` already declares the shell hooks: the pack decides whether its
sources are offered, listed and health-checked; disabling the pack removes them.

## Clarifications

### Session 2026-09-24

- Q: Is the proposed split right? → A: Yes.
- Q: Keep per-source `enabled` keys and add a pack switch, or pack switches
  only? → A: **Pack switches only.** `clipboard.enabled`,
  `fileWatcher.enabled`, `processMonitor.enabled`, `connectionMonitor.enabled`,
  `powershellTranscript.enabled` and `agentTailer.enabled` are removed and no
  longer read (Spec 006: no migration). Member tuning (poll intervals, watch
  paths, ignore lists, `emitThinking`) stays.
- Q: Should automatic screenshots be a pack? → A: No — they stay a Capture
  setting; they are a frequency of the built-in screenshot, not a source.
- Q (design): where does a pack switch live? → A: per project,
  `packs.<id>` (booleans), because what is recorded is part of the engagement.
  The pack's bundled manifest (`plugins/pack-*/plugin.json`) makes it a plugin:
  disabling it in Plugins removes the pack everywhere. A pack runs only when
  the project turns it on **and** its plugin is active.

## Split

| Tier | Sources | Default |
|---|---|---|
| **Core, not removable** | evidence chain, ingest, redaction/secret masking, pause, scope, markers, manual screenshot, built-in terminal (.cast) | always |
| **Essential capture** | shell hooks (starter-pack, with in-code fallback); **HTTP(S) capture** — managed mitmdump + proxied browser/CDP, and the same addon under an operator-run mitmproxy; `redlog-session` PTY; built-in key/hash loot rules | on |
| Pack: **Host monitors** | process monitor, connection monitor, file watcher, clipboard | off |
| Pack: **AI agents** | Claude Code / Codex / OpenCode transcript tailers | off |
| Pack: **Windows output** | PowerShell Start-Transcript follower | off |
| Pack: **Network, privileged** | transparent HTTP(S) interception (root), pcap | off (already plugins) |
| Pack: **C2** | C2 log tailers | off (already a plugin) |
| Pack: **Detection rules** | MITRE command tags, extra loot rules (jwt/generic already off by default) | per rule |

HTTP(S): the managed proxy, an operator-run mitmproxy and transparent mode all
run the same `hooks/mitmproxy-addon.py` and emit identical events. They are
presented as one source with three modes, not three producers.

## User Scenarios & Testing

### User Story 1 - See what is recorded by default (Priority: P1)

**Independent Test**: Settings ▸ Capture lists the essential sources and each
pack with one switch; a fresh project records shell commands, HTTP(S) through
the managed proxy and PTY sessions, and nothing from a disabled pack.

### User Story 2 - Add a capability as one step (Priority: P1)

**Independent Test**: Enabling "Host monitors" enables its members; capture
health lists them; disabling the pack removes them from health and Settings.

### Edge Cases

- A pack's member can still be tuned (poll interval, watch paths) where it is
  today; the pack switch does not replace member settings.
- A missing or corrupt pack manifest falls back to the in-code declaration
  (starter-pack's existing rule), so essential capture never goes dark from a
  data file.
- Secret masking and scope are not packs: switching them off would expose data.

## Requirements

- **FR-001**: Each optional source MUST be declared by a bundled pack manifest.
- **FR-002**: Disabling a pack MUST remove its sources from Settings, capture
  health and startup.
- **FR-003**: Essential capture MUST NOT depend on a pack being enabled.
- **FR-004**: Settings ▸ Capture MUST show essential capture and packs with one
  switch per pack; the member `enabled` keys MUST no longer exist or be read.
- **FR-005**: HTTP(S) capture MUST be presented as one source with its modes.

## Out of scope

- The network (transparent proxy, pcap) and C2 packs are already plugins and
  keep their current shape.
- Detection rules already have per-rule switches (Spec 032).
