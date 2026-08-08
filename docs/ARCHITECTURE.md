# Architecture

Current as of **v0.9.3**. This page is the map the README's ASCII diagram
stopped being (that diagram predates the tailer host, plugin host,
marketplace and cloud share). Read `event-schema.md` for what lands on the
timeline and `audit-trail.md` for why it can't be quietly edited.

## 1. Process / layer model

```
┌─ renderer (React 18, sandbox:true, contextIsolation:true, no nodeIntegration) ─┐
│  App.tsx · Timeline · TerminalView · Settings · OverlayApp (2nd window)        │
│  talks only through window.redlog.*                                            │
└──────────────▲──── ipcRenderer.invoke / on ───────────────────────────────────┘
┌──────────────┴─ preload (src/preload/index.ts, overlay.ts) ───────────────────┐
│  contextBridge.exposeInMainWorld('redlog', …) — pure forwarding, zero logic    │
│  24 namespaces, ~100 methods; every subscribe returns an unsubscribe closure   │
└──────────────▲────────────────────────────────────────────────────────────────┘
┌──────────────┴─ main (src/main/) — needs Electron ────────────────────────────┐
│  index.ts        composition root + every ipcMain handler (~1900 LOC)          │
│  windows · tray · terminal-manager (node-pty) · clipboard-monitor              │
│  services/  screenshot-agent · cdp-connector · browser-launcher · file-watcher │
│             process-monitor · opsec-state · network-info · updater             │
│             tailer-host + adapters/{claude-code,codex,opencode}                │
└──────────────▲────────────────────────────────────────────────────────────────┘
┌──────────────┴─ core (src/core/) — zero Electron imports, unit-testable ──────┐
│  db/{index,events,operators,findings}   event-bus   clock   signing            │
│  chain-anchor   evidence-chain   bundle-export   sanitize   redaction          │
│  api-server (REST + HTTP MCP)   mcp-tools   capture-health   deconfliction     │
│  loot- / pivot- / technique- / command- / target- detectors   scope-monitor    │
│  ip-monitor   retention   cloud-share   plugins/{loader,manifest,trust,host,…} │
└───────────────────────────────────────────────────────────────────────────────┘
        ▲ HTTP 127.0.0.1:6660 (Bearer)         ▲ file watch
   hooks/ · shell/ · cli/ · mcp/ ·        ~/.claude · ~/.codex · opencode storage
   mitmproxy addon · VPS reverse tunnel
```

**Why `core/` exists.** Anything that does not need an Electron API lives
there, so the same function backs the REST route, the MCP tool, the CLI
subcommand and the vitest file. `test/` has 40 files against `core/`; the
`main/` layer is deliberately thin glue (and, as a consequence, mostly
untested — see `AUDIT-2026-08-08.md` §4).

## 2. Startup order

### App level (`src/main/index.ts`)

1. `:58` Windows-only Chromium switches.
2. `:708` `requestSingleInstanceLock()` — second instance quits rather than
   fight over port 6660 and `~/.redlog/api-token`.
3. `:724` `protocol.registerSchemesAsPrivileged(['redlog-screenshot'])` —
   must run **before** `whenReady`.
4. `app.whenReady()` → screenshot protocol handler (path-traversal guarded
   by `isInsideDir`), permission handler (geolocation only), main window +
   tray, **all ipcMain handlers**, `Cmd/Ctrl+Shift+M` global marker, update
   check after 5 s.

### Project level (`startProject()` `:347-684`)

```
loadConfig → initDB(projectDir)               timeline.db, WAL, triggers
→ configure ip / screenshot / scope / loot / redaction
→ setPluginHost → setTailerContributionSink → initPlugins()
→ configureDeconfliction · setVpnAdapters · configureTerminal
→ sweepRetention()            expire .cast / screenshots, emit *_pruned events
→ recoverOrphanSessions()     LEFT JOIN to close terminals killed by a crash
→ replay ~/.redlog/pending/*  shell-hook offline spool
→ start ip / link / opsec / clipboard / fileWatcher / processMonitor / tailer
→ configureApi → startApiServer(6660) → system.api_started
→ autoUpgradeInstalledHooks()
→ insertEvent(system.session_start)
→ startAnchorLoop() + startNtpLoop()
→ verifyRandomSample(100), then 50 every 5 min
→ create overlay window
```

Shutdown (`stopProject()` / `will-quit`) flushes the deconfliction batch,
kills terminals **before** closing the DB so `session_end` still writes, then
unwinds every monitor and calls `closeDB()`.

## 3. Data model

`<projectDir>/timeline.db`, `journal_mode=WAL`, `foreign_keys=ON`.

| Table | Purpose |
|---|---|
| `events` | The only evidence table. Append-only, hash-chained, Ed25519-signed. |
| `operators` | `token_hash` (sha256 of the bearer token) + `signer_pub_key`. |
| `chain_anchors` | OpenTimestamps anchors + calendar receipts. |
| `sanitized_events` | Layer-4 redaction: `(source_event_id, field) → replacement`. Never an UPDATE on `events`. |
| `quickmarks` | Bookmarks. Not chained. |
| `event_annotations` | Created but currently unused — no read/write path exists. |

Indexes: `timestamp`, `agent_type`, `engagement_id`, `target_id`,
`created_at`, plus one each on quickmarks / operator token / anchors /
sanitized source.

### Migration strategy

No version table. Every open runs idempotent DDL (`CREATE TABLE IF NOT
EXISTS`), then probes `PRAGMA table_info` and `ALTER TABLE ADD COLUMN` for
`prev_hash` / `monotonic_ns` / `ntp_offset_ms` / `signature` /
`signer_pub_key`. All added columns are nullable and **never backfilled** —
backfilling would change historical hash inputs.

`assertEventsAppendOnly()` drops and recreates two triggers on every open:

- `no_delete_events` — any DELETE raises ABORT.
- `no_update_events_hash` — UPDATE of any hash-covered column raises ABORT.

### Event envelope

Fixed columns carry identity and integrity; semantics live in the free-form
`data` JSON, keyed to stay Ghostwriter-Oplog-compatible (`command`, `output`,
`dest_ip`, `dest_host`, `mitre_ttp`, `description`, `sha256`, `severity`, …).

Two reserved internal keys:

- `_causes: string[]` — causal edges, resolved in `causes-resolver.ts` by
  `flow_id` (HTTP) or `terminalId|pid|command` (shell) through a bounded
  in-memory map (cap 10 000).
- `_clock_anomaly` — stamped at write time and folded into the hash input, so
  it cannot be removed after the fact.

18 lanes render from `agent_type` (+ `subtype` routing): `shell`, `agent`,
`http_navigation`, `scanner`, `browser`, `dns`, `pivot`, `screenshot`,
`clipboard`, `file_transfer`, `credential_use`, `c2_checkin`, `marker`,
`loot`, `cleanup`, `scope`, `process`, `system`.

## 4. Capture pipeline

The canonical path, shell hook → chain → UI:

```
hooks/shell-preexec-hook.sh   zsh preexec/precmd · bash DEBUG trap
  ├ resolve ~/.redlog/{api-port,api-token}  (WSL: via cmd.exe + wslpath)
  ├ python3 builds the JSON payload
  ├ curl POST /api/events  --connect-timeout 1 --max-time 2
  └ on failure → ~/.redlog/pending/<ns>.<pid>.json   (cap 5000, replayed at
                                                      next startProject)
POST /api/events (src/core/api-server.ts:334)
  1  selfHealSidecarFiles()      rewrite token/port if deleted
  2  Host allowlist (anti DNS-rebinding) + reflected Origin (never `*`)
  3  Bearer → resolveOperatorByToken
  4  resolveIncomingCauses → data._causes
  5  STRIP any operator_id in the body — attribution comes from the token only
  6  shell normalisation: tagCommand · detectCleanup · detectFileTransfer ·
     detectPivot · extractTargetWithProvenance · scopeMonitor.checkTarget ·
     lootDetector.findMatches(cmd + stdout + stderr + output)
  7  redact() — marks spans into data.redactions; raw bytes are NOT altered
  8  insertEvent()             ← the single write point
  9  eventBus.publish() → lootDetector.emit(_causes = event.id)
 10  companion events: pivot / cleanup / file_transfer / pivot-closed
insertEvent (src/core/db/events.ts:230)
  · 2 s dedupe (subtype + command + terminalId)
  · prevHash from an in-memory cache; reset to sentinel if an INSERT fails
  · operatorId required, else throw
  · clock-anomaly detection folded into data
  · canonicalStringify (recursive key sort) → SHA-256 → hash → Ed25519 sig
main/index.ts:1063
  · send 'events:new'          per event (HUD + deconfliction)
  · notifyDeconfliction()      500 ms / 100-event batches, HMAC-SHA256
  · batchBuffer + setImmediate → 'events:new-batch'  (one per frame)
  · recompute getActivePivots() on pivot / command_end → 'pivots:changed'
```

### Sources

| Source | Mechanism | Notes |
|---|---|---|
| shell preexec hook | bash/zsh/pwsh + curl | offline spool; **no stdout** unless prefixed with `redlog-run` |
| `redlog-run` wrapper | temp files per stream | structured `stdout` / `stderr`, 100 KB each |
| built-in terminal | node-pty | asciinema `.cast` per session, 50 MB cap, SHA-256 on `session_end` |
| clipboard | Electron poll (**off by default**) | stores sha256 + length + lootTypes; raw text never persisted |
| screenshot | desktopCapturer + JPEG | exact sha256 dedupe, then dHash Hamming < 5 |
| browser CDP | `/json` poll 3 s + per-tab WebSocket | `http_navigation` + console/exception, 2 KB msg cap |
| mitmproxy | `hooks/mitmproxy-addon.py` (604 LOC) | HTTP `scanner` + DNS `dns`; bodies capped at `REDLOG_MAX_BODY` (2048) |
| IP monitor | DNS (OpenDNS/Google TXT) then HTTP echo | N-consecutive confirmation before a state change |
| OPSEC monitor | `os.networkInterfaces()` + platform DNS, 30 s | VPN iface / resolver / MAC / hostname drift |
| scope monitor | per-command target check | root-domain matched; **never blocks** |
| loot detector | 10 built-in regexes + plugin patterns | `plugin_id` + `pattern_name` provenance since v0.9.0 |
| pivot detector | command pattern match | ligolo / chisel / sshuttle / proxychains / ssh -D,-L,-R / socat |
| file watcher | chokidar (**off by default**) | too noisy otherwise |
| process monitor | `ps` poll 500 ms | not supported on Windows; saturation event above 1000/min |
| agent tailer | chokidar over transcript files | see §5 |

## 5. Tailer host (AI agent capture)

`tailer-host.ts` owns the generic pipeline; `TailerAdapter` implementations
own the per-agent parsing. This is a capture source like any other — the
shell hook records what the operator typed, the tailer records what the agent
did. Same chain, same operator attribution, same pause semantics.

- **Watch** — chokidar over `transcriptGlob` (JSONL append or
  per-message directory).
- **Sidecar** — appends source bytes to
  `<projectDir>/agent-transcripts/<kind>-<session>.jsonl`; sidecar size is
  the read offset, which makes crash recovery idempotent by construction. A
  shrinking source means `/compact` → reset + `transcript_compacted`.
- **Gates** — `.redlog-app-root` self-exclusion (RedLog's own repo carries
  this marker), `excludedPaths` / `watchPaths`, and `eventBus.paused`.
- **Redaction** — `deepRedactStrings()` walks every string; sensitive paths
  (`.ssh/`, `.env`, `.aws/`) suppress the output field entirely.
- **Causality** — `redlogIdByUuid` is reseeded from the DB on project open;
  late parents go into a pending buffer (cap 100, TTL 60 s) and flush
  recursively.
- **Integrity** — a `transcript_snapshot` (cumulative sidecar sha256) is
  emitted on 15 s idle or session close, so bundles can omit the raw
  transcript and still be verifiable.

Adapters: `claude-code` (`~/.claude/projects/**/<session>.jsonl`), `codex`
(`~/.codex/sessions/**/rollout-*.jsonl`, synthesises ids since Codex has no
wire-level uuid), `opencode` (`storage/message/` + secondary `storage/part/`
watcher).

## 6. Evidence chain

Three layers, documented in full in `audit-trail.md`:

1. **Hash chain** — `canonicalStringify` (recursive key sort, array order
   preserved, `undefined` skipped) → SHA-256; `prev_hash` points at the
   previous row's `hash`. Detects deletion, edit and reorder; does **not**
   detect a full rewrite by someone with the source.
2. **Per-event Ed25519 signature** — key at `~/.redlog/keys/<op>.key`
   (0600, dir 0700), public half mirrored into `operators.signer_pub_key` so
   verification never touches disk. Missing key → row marked unsigned rather
   than failing the write.
3. **OpenTimestamps anchoring** — `computeChainHead() = SHA256(last.hash ‖
   String(count))`, POSTed hourly to three public calendars; `partial` when
   some fail, `system.anchor_failed` when all do. `chain upgrade` polls for
   the Bitcoin-folded proof; `.ots` export produces a file any `ots verify`
   accepts.

**Verification has three gears**: `verifyLatestAnchor()` (O(1) count check),
`verifyChainFull()` / `…Async()` (per-row re-walk, 6 hash shapes tried
newest-first, clock drift > 5 s reported), and `verifyRandomSample(K)`
(100 at open, 50 every 5 min; failure flips capture-health to `dark` and
writes `system.chain_sample_broken`).

## 7. Export & delivery

`bundle-export.ts` streams to `<projectDir>/exports/bundle-<ts>/`:

`events.jsonl` (sanitized replacements applied **to the export only**),
`quickmarks.json`, `chain_anchors.json`, `operators.json` (public fields +
pubkey, no token hashes), `screenshots/`, `casts/`, optional
`agent-transcripts/` (**off by default** — raw agent chat may contain pasted
secrets), a self-contained `redlog-verify.py` + `verify.sh` / `verify.cmd`,
`manifest.json` (per-file sha256, chain head, last anchor), `manifest.sha256`
and `manifest.hmac` (HMAC-SHA256 keyed by the primary operator's token_hash).

Cloud share wraps that in a zip + `bundle.json` behind a mandatory redaction
review gate; the BYO Cloudflare Worker lives in `redlog-share-worker/`.

## 8. Plugin system

Two tiers, decided by `manifest.ts:PRIVILEGED_KEYS`:

| Tier | Contributions | Executes in RedLog? |
|---|---|---|
| 🟢 declarative | `lootPatterns`, `redaction`, `commandTags`, `targetExtractors`, `eventTypes`, `capture` | no |
| 🔴 privileged | `mcpTools`, `tailers`, (`exporters`, `monitors` reserved) | yes |

`mcpTools` run in `utilityProcess.fork()` with a capability-scoped RPC
surface (`read:events`, `write:events`, `read:findings`, `read:config`,
`net:outbound`), a 30 s per-call timeout, and no access to the DB handle or
signing keys. Trust is pinned to a content hash covering the manifest plus
every privileged code file; changing either the code or the requested
capabilities revokes it automatically.

Marketplace install: revocation check → HTTPS fetch (5 MB cap, one redirect,
20 s timeout) → sha256 match → Ed25519 verify against a pinned publisher key
→ tar-escape pre-check → extract to scratch → manifest re-validation → tier
post-check → atomic rename with the previous version snapshotted.

`tailers` is the exception and currently does **not** follow this path — see
`AUDIT-2026-08-08.md` §2 (P1-3).

## 9. IPC conventions

- `invoke`/`handle` for request-response; `send`/`on` for high-frequency or
  fire-and-forget (`terminal:write/resize/kill`, `overlay:*`).
- Channel names are `<namespace>:<verb>`; main→renderer pushes use a
  noun/past-tense form (`events:new`, `pivots:changed`, `recording:changed`).
- Per-pty dynamic channels: `terminal:data:<id>`, `terminal:exit:<id>`.
- E2E-only handlers gate on `process.env.REDLOG_E2E === '1'`, never
  `NODE_ENV`.
- Renderer types are **hand-mirrored** in `src/renderer/src/env.d.ts` — there
  is no automatic inference from preload, and it has drifted (§4 of the
  audit).
