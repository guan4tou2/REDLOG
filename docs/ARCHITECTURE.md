# Architecture

Current as of **v0.9.3**. This page is the map the README's ASCII diagram
stopped being (that diagram predates the tailer host and plugin host).
Read `event-schema.md` for what lands on the
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
│  api-server (REST)   capture-health                                           │
│  loot- / pivot- / technique- / command- / target- detectors   scope-monitor    │
│  ip-monitor   retention   cast-index   plugins/{loader,manifest,trust,host,…}  │
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
→ setVpnAdapters · configureTerminal
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

Shutdown (`stopProject()` / `will-quit`) kills terminals **before** closing the
DB so `session_end` still writes, then unwinds every monitor and calls `closeDB()`.

## 3. Data model

`<projectDir>/timeline.db`, `journal_mode=WAL`, `foreign_keys=ON`.

| Table | Purpose |
|---|---|
| `events` | The only evidence table. Append-only, hash-chained, Ed25519-signed. |
| `operators` | `token_hash` (sha256 of the bearer token) + `signer_pub_key`. |
| `chain_anchors` | OpenTimestamps anchors + calendar receipts. |
| `sanitized_events` | Layer-4 redaction: `(source_event_id, field) → replacement`. Never an UPDATE on `events`. |
| `bookmarks` | Private bookmarks — the 書籤 page. Not chained, not signed, not attributed, editable in place, and not evidence. |
| `event_annotations` | Created but currently unused — no read/write path exists. |

Indexes: `timestamp`, `agent_type`, `engagement_id`, `target_id`,
`created_at`, plus one each on bookmarks / operator token / anchors /
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
hooks/shell-zsh-hook.zsh     zsh preexec/precmd adapter
hooks/shell-bash-hook.sh     bash DEBUG/PROMPT_COMMAND adapter
hooks/shell-common.sh        shared transport, spool and redlog-run
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
  · send 'events:new'          per event (HUD)
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
`verifyChainFullAsync()` (per-row re-walk, chunked so the main loop keeps running, 6 hash shapes tried
newest-first, clock drift > 5 s reported), and `verifyRandomSample(K)`
(100 at open, 50 every 5 min; failure flips capture-health to `dark` and
writes `system.chain_sample_broken`).

## 7. Export & delivery

`bundle-export.ts` streams to `<projectDir>/exports/bundle-<ts>/`:

`events.jsonl` (sanitized replacements applied **to the export only**),
`chain_anchors.json`, `operators.json` (public fields +
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
| 🔴 privileged | `tailers` (bundled only) | yes, in the main process |

Privileged code — today only a bundled tailer — is loaded into the main
process. There is no isolated process and no capability-scoped RPC: that host
ran nothing after v0.12 (`mcpTools`, its only user, was retired in #88) and was
removed in Spec 027, with the `exporters` and `monitors` contributions only it
could have run. Because a tailer is not isolated, only bundled plugins may
contribute one (see `AUDIT-2026-08-08.md` §2, P1-3).

Trust is pinned to a content hash covering the manifest plus every privileged
code file and capture hook; changing either the code or the requested
capabilities revokes it automatically.

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

## 這個 codebase 會咬人的地方

> 原載於 2026-09 交接文件（已歸檔），仍然有效。

接手前讀完這一節，可以省下我這輪踩過的每一個坑。

### native module 的 ABI 陷阱

`better-sqlite3` 是原生模組，**vitest 需要 Node ABI，e2e 需要 Electron ABI**。切換：

```bash
npx electron-rebuild -f -w better-sqlite3   # 換成 Electron ABI（跑 e2e 前）
npm rebuild better-sqlite3                  # 換回 Node ABI（跑 unit 前）
```

忘了換回來的症狀是 **unit 測試整批 skip 而不是失敗**——DB 相關的 suite 用
`describe.skipIf(!available)` 保護。看到 `Tests 8 skipped (8)` 就是這件事。

那個保護的正確寫法在 `test/cast-index.test.ts:11-21`：**必須 `new Database(':memory:')` 探測**，
只 import 是不夠的（binding 是延遲載入的，import-only 的守衛會回報「可用」然後在被測模組內部炸掉）。

### TDZ：只在打包後才出現的崩潰

React hook 的 dep array 在 render 時求值。一個 hook 若引用**宣告在它下面**的 `const`，在
esbuild 打包後會是 temporal-dead-zone 崩潰——而 **vitest 看不到**，因為它是逐檔轉譯原始碼。

這個 codebase 已經被咬過**三次**（`TargetView` 的 listNav、`Timeline` 的 `collapsedBands`、
`App` 的 visibility memo）。相關檔案裡都寫了契約註解，照著擺：`Timeline.tsx` 的 fold memo 在
`effectsById` 之後、`badgesById` 之前，`App.tsx` 的 visibility memo 緊接狀態區。

**e2e 是唯一的守衛。** 動過 Timeline.tsx 或 App.tsx 的 hook 順序就跑 `npm run build && npm run e2e`。

### 兩層事件表

`events`（上鏈）與 `events_logged`（支撐證據，30 天後清）。`classifyTier` 決定去哪一張，
未列出的 pair 預設 chained。**任何 join 或聚合都必須考慮兩張表**——語料大半在 logged 層
（所有 HTTP、DNS、browser console、agent thinking）。

已知的例外：`searchEvents` 只查 `events`。這是既有行為，不是這輪造成的。

### 腳本化編輯要 assert

我這輪犯過一次：一個 `s.replace(old, new)` 的錨點不符、靜默跳過，害 `scopeSignalFor` 的 import
沒落地。dispatch 在 insert 之前，所以**任何帶目標的 shell POST 都會 500,連事件都沒寫進去**——
擷取靜默停掉，三個 commit 後才被 e2e 抓到。

現在有 typecheck 會接住這一類。但仍然：批次編輯後，grep 一下該編輯應該引入的識別字。

### 不要對正在編輯的檔案下 `git checkout --`

它會還原到 HEAD，包含未提交的工作。我用它撤銷一行故意改壞的測試，連帶清掉了同一個檔案裡
一小時的改動。

### 從原始碼解析的守衛測試

這個 repo 有一批測試是讀 `.ts` 原始碼、用 regex 斷言規則的（`design-tokens`、`lane-colours`、
`buttons`、`truncation`、`danger-not-on-numbers`、`list-keyboard`、`i18n-keys`、
`housekeeping-parity`、`redaction-boundary`、`typecheck-guard`）。改 UI 前先看它們要什麼。

兩個容易忘的：**截斷的 span 一定要有 `title`**；**危險紅絕不出現在數字上**（`tabular-nums` 與
danger 類名不能出現在同一個 className）。

### i18n 掃描器看不到動態鍵

`test/i18n-keys.test.ts` 只掃字面 `t('a.b')`。用變數組出來的鍵它看不到——`sidebar.http_history`
就是這樣漏掉的，那個鍵兩本語言檔都沒有，直接把鍵名印給操作員。

掃描器現在也認 `reasonKey: 'a.b'` 字面值。再有這種模式，記得一起加進去。

---
