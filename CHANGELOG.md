# CHANGELOG

RedLog release history. Each entry links to the tag; run `gh release view v0.6.x`
for full commit body + generated notes.

## v0.6.79 — 2026-08-01
- **Swap Aider → OpenCode plugin**: `examples/plugins/aider-hook/` dropped,
  `examples/plugins/opencode-hook/` added. Rationale: Aider has no
  first-class hook API (issues #1215 / #1337 still open — the only
  workaround was a subprocess.Popen monkey-patch that would fight upstream
  every release), whereas OpenCode ships a native plugin API
  (`tool.execute.after`) and auto-loads any `.mjs` / `.ts` from
  `.opencode/plugins/` or `~/.config/opencode/plugins/`. The new plugin is
  a single ~130-LOC ES module that reads `~/.redlog/api-token`, applies
  the same two-gate privacy filter (recording + cwd exclusion), redacts
  common secret patterns, and POSTs a `subtype: opencode_tool` event
  after every tool call. Verified against
  `https://opencode.ai/docs/plugins/` (2026-08). Example registry updated
  to serve the new tarball; `docs/plugin-development.md` §"Full example"
  rewritten to walk through the OpenCode plugin structure end-to-end.
- **Marketplace install-fail inline error**: install failures now show a
  persistent red box under the failing entry with the exact error + a
  dismiss button, matching the cloud-share pattern from v0.6.76. The
  transient toast still fires but no longer swallows the message before
  operators can read it. Reported after v0.6.74 DMG test — install
  refused because publisher untrusted, but the operator saw nothing on
  screen after the toast faded.
- **Config-level default registry URL**: new `marketplace.defaultRegistryUrl`
  in `config.yaml` — the Settings placeholder + one-click fetch (empty
  URL box) both honour it. Ships defaulting to this repo's example
  registry (`raw.githubusercontent.com/.../examples/registry/index.json`)
  so it works out of the box; air-gapped shops override to point at their
  internal mirror.

## v0.6.78 — 2026-08-01
- **UI hotfix**: five i18n strings added in v0.6.76–v0.6.77 used
  single-brace `{key}` interpolation, but the app's `t()` helper matches
  `{{key}}` only — so operators saw literal `{size} KB`, `{{n}}
  publishers`, `{cap} MB` on cloud-share cap warnings, etc. Ship-time
  DMG test on v0.6.74 caught the marketplace side (`{size} KB` under
  each listed plugin). Fixed all five (`marketplace.sizeKb`,
  `marketplace.publishersAdded`, `marketplace.suggestedPublishersTitle`,
  `cloudShare.capExceedWarning`, one more). No behaviour change beyond
  the display text.

## v0.6.77 — 2026-08-01
- **Codex + Aider plugin corrections** (verified against upstream docs):
  - Codex config path was wrong: `~/.codex/config.toml` (not
    `~/.config/codex/config.toml`). Hook block is
    `[[hooks.PostToolUse]]` (PascalCase), not `post_tool_use`. Verify
    command is `codex exec 'run <cmd>'`. Docs URL pinned in the script
    header (`learn.chatgpt.com/docs/hooks`).
  - Aider had **no shell-override env var** at all — the v0.6.76 plugin's
    `AIDER_SHELL_CMD` assumption is Aider issue #1215 / #1337, still
    open. Rewrote around what Aider *actually* does on the pexpect (TTY)
    code path: `os.environ['SHELL']`. Wrapper now parses `-i -c '<cmd>'`
    per real invocation and points the manifest at
    `SHELL=… aider` (per-invocation, not global rc). README documents
    the non-TTY / Windows / piped-input path as uncapturable with a link
    to `aider/run_cmd.py` and the two open issues.
- **Marketplace one-click publisher trust**: registries can now advertise
  a `publishers[]` block in `index.json` carrying SPKI keys; when the
  operator fetches a registry that lists publishers they haven't trusted
  yet, an amber banner surfaces "This registry suggests trusting N
  publisher(s)" with a Trust-all button. Skips the paste-a-base64-SPKI
  ceremony for well-known registries; individual publishers can still be
  untrusted from the Publishers tab. Example registry updated to include
  the `redlog-project` publisher block so the flow works out of the box
  at the default URL.
- **Test**: cloud-share preview raw vs approx-compressed math now covered
  by a dedicated unit test that plants known-size fixture files under
  the mocked project dir and asserts the 1.02x / 0.15x / 0.20x ratios.
  Suite 256 → 257.
- **E2E**: cloud-share flow assertion updated for the v0.6.76 label
  split (`Raw size (pre-zip)` + `Approx. zipped` replaced `Approx.
  size`). CI was red on this since v0.6.76; now 11/11 green in ~10 s.

## v0.6.76 — 2026-08-01
- **UX (Timeline)**: lane filter chips now scroll horizontally when the
  header narrows instead of wrapping onto a second row that pushed the
  minimap down. Reported: at 1280-wide with all lanes visible, the chip
  row was breaking the Attack Timeline header layout.
- **UX (cloud-share)**: three fixes reported after v0.6.71 usage —
  - Preview now shows both raw-bytes AND estimated-zipped size (v0.6.71
    only showed raw, which under-reported how close the operator was to
    the 100 MB cap since JSONL + text .cast compress hard). Added a red
    warning line when the compressed estimate is over cap.
  - New `cloudShare.maxBundleBytes` in config + Settings ▸ 資料 ▸
    Cloud share ▸ Advanced input so operators can raise the client-side
    cap. Note: the deployed Worker enforces its own `MAX_UPLOAD_MB`, so
    both need to be raised in tandem.
  - Persistent inline error box below the panel — the failure toast
    used to fade before the operator saw it. The box stays until they
    dismiss or retry.
- **examples/plugins/codex-hook + aider-hook** (new): reference
  implementations of the two integration tiers documented in
  `docs/plugin-development.md`. Codex uses the native hook API (stdin
  JSON, same shape as Claude Code); Aider uses the `AIDER_SHELL_CMD`
  shell-wrapper. Both apply the two-gate privacy filter (recording state
  + cwd exclusion list) and redact secrets before POST. Both are
  🟢 declarative — drop under `~/.redlog/plugins/` and reload.
- **examples/registry/** (new): a working example marketplace index
  hosting the three declarative plugins (recon-pack, codex-hook,
  aider-hook), signed with a bundled Ed25519 key. Point Settings ▸
  外掛市集 URL at
  `https://raw.githubusercontent.com/guan4tou2/REDLOG/main/examples/registry/index.json`
  to actually fetch + install. Marketplace UI placeholder updated to
  suggest the same URL. Real DNS at `plugins.redlog.dev` is a v2 item.
- **redlog-share-worker/smoke.js** (new): post-deploy smoke test.
  Verifies every endpoint in the two-step upload contract — `/health`,
  authed + unauthed `/api/share/init`, `PUT` to R2, `/share/:slug`
  download page, 302 redirect to signed R2, `/api/share/revoke/:slug`,
  post-revoke 404/410. Run with `node smoke.js <worker-url> <AUTH_TOKEN>`
  after `wrangler deploy`; exits 0 all-green, 1 on first failure.

## v0.6.75 — 2026-08-01
- **API sidecar self-heal**: `redlog-cli` was bailing with "no api-token
  found" on installs where the API server was clearly up (port 6660
  listening, /api/health 200) — because on some machines the sidecar
  files (`~/.redlog/api-token`, `~/.redlog/api-port`) had been dropped
  between an old `stopApiServer` and something else (macOS session
  restore, an operator cleanup, a Finder move). Two-part fix:
  - `stopApiServer` no longer unlinks the files. They're mode 0600, so
    leaving them across a stop/start cycle costs nothing; a startApiServer
    rewrite is idempotent.
  - Every request handler now runs `selfHealSidecarFiles()` — if either
    file is missing at request time, it's rewritten from the in-memory
    token+port. Effectively self-repairing whenever the CLI reads the
    file, so the operator never sees a broken CLI on a working server.

## v0.6.74 — 2026-08-01
- **Windows release-CI hotfix (round 4, root cause this time)**: the
  `localFileUploader` built its URL with `` `file://${destZip}` `` — on
  Windows that produces `file://C:\Users\...\.redlog\shares\...`, which is
  malformed (should be `file:///C:/Users/...` — three slashes + forward
  separators). Test assertions patched to accept backslashes in v0.6.73
  matched the string but `new URL(...).pathname` on the malformed form
  returned garbage and `fs.existsSync` failed. Fix at the source: use
  Node's `pathToFileURL()` which produces a spec-compliant URL on every
  OS, and consumers use `fileURLToPath()` to decode. Tests + E2E regex
  simplified back to a single-shape assertion.

## v0.6.73 — 2026-08-01
- **Windows release-CI hotfix (round 3)**: the v0.6.71-era cloud-share
  regex assertions only accepted forward slashes, but Windows produces
  `file://C:\Users\...\.redlog\shares\<sha8>\...` (backslashes) — so both
  `test/cloud-share.test.ts` and `e2e/cloud-share-flow.spec.ts` failed on
  Windows even after v0.6.72's zip archiver fix. Regex now accepts both
  separators (`[\\/]`) — same URL, OS-appropriate slashes.

## v0.6.72 — 2026-08-01
- **Windows release-CI hotfix**: v0.6.71's Windows zip path used
  `Compress-Archive -LiteralPath '$dir\*'`, but `-LiteralPath` is literal by
  design — it doesn't glob, so the zip was silently empty and the
  post-build `fs.statSync` blew up. Swap to `tar.exe -a -c -f` (Windows
  10+ ships bsdtar, which handles the `.zip` extension natively).
- **Cloud-share HTTPS backend lands (deployable, not deployed)**:
  new `redlog-share-worker/` — a Cloudflare Worker (~300 LOC) + `wrangler.toml`
  + README that a deployer runs against their own Cloudflare account. R2 for
  the bundle bytes, KV for per-share metadata, HMAC-signed short-lived
  PUT/GET tokens scoped to the sha256, `/api/share/init` → `/api/share/put/:sha`
  → `/share/:slug` public download page. `TODO(magic-link)` on the bearer
  auth per spec §10.
  - `src/core/config.ts` grows a `cloudShare: { endpoint, authToken }` block.
  - Settings ▸ 資料 ▸ Cloud share adds an "Advanced: HTTPS backend"
    collapsible with endpoint + token inputs and a stub-vs-https radio pair.
    When HTTPS is selected AND both fields set, the Share button dispatches
    to the real `httpsUploader` from `cloud-share-uploader.ts`. Still uses
    the same mandatory redaction gate.
  - `test/cloud-share-uploader.test.ts` — loopback-mocked unit test for the
    two-step wire contract (POST init → PUT bytes → sha256 re-check).
  - `README.md` gains a short "Cloud share backend (optional)" section
    linking to `redlog-share-worker/README.md`.
- **Marketplace E2E lands**: `e2e/marketplace-flow.spec.ts` — three tests
  (install a declarative plugin via IPC, trust a publisher via UI + confirm
  via listPublishers, install v1 → v2 → rollback restores v1's marker
  file). New dev-only `marketplace:testInstall` IPC gated on `REDLOG_E2E=1`
  in main so the E2E can drive `installFromRegistry` with an injected
  fetcher — production paths keep HTTPS enforcement. Real gzipped POSIX
  ustar tarballs built in-test exercise the default `tar` extractor
  end-to-end. `npm run e2e` now runs 7 tests in ~5.9s.

## v0.6.71 — 2026-08-01
- **Cloud-share bundle v1** (spec: [`docs/CLOUD_SHARE_BUNDLE.md`](docs/CLOUD_SHARE_BUNDLE.md)).
  End-to-end flow lands with a local file:// stub uploader — real HTTPS
  backend gets wired next; this pass proves the client contract.
  - `src/core/cloud-share.ts` — wraps the existing local `exportBundle` with
    a `.zip` archive + outer `bundle.json` manifest carrying zip sha256,
    engagement metadata, event/sanitize counts, chain head. Uses `zip -r` on
    POSIX and `powershell Compress-Archive` on Windows.
  - `src/core/cloud-share-uploader.ts` — pluggable `Uploader` interface with
    two implementations: `localFileUploader` (writes to
    `~/.redlog/shares/<sha8>/` and mints a `file://` share URL, the v1
    default) and `httpsUploader` (POST /api/share/init → PUT signedUrl, gated
    on backend sha256 re-check per spec §5, unused from UI until the
    backend exists).
  - **Hard redaction gate**: `prepareCloudShareBundle` throws
    `RedactionGateError` unless the caller passes `reviewedByOperator: true`.
    The Settings UI wires this to a mandatory checkbox above the Share
    button that reads out what the bundle contains (events, sanitize count,
    screenshots, cast files, approx size, chain head) — no muscle-memory
    click-through.
  - `BundleTooLargeError` at the 100 MB spec cap; oversized `.zip` cleaned
    up rather than left on disk.
  - Settings ▸ 資料 gains a Cloud share panel above the integrity check
    with expiry picker (24h/7d/30d/90d/never), review-gate checkbox, and a
    copy-URL + open buttons once the stub returns a share path.
  - Coverage: 7 new tests (`cloud-share.test.ts`) covering the gate,
    manifest shape, oversized-cleanup, stub upload sha8 bucketing, and
    `expiresIn: 'never'` omission. Suite now 255 tests, 27 files.

## v0.6.70 — 2026-08-01
- **Windows release-CI hotfix**: `publisher-trust` + `marketplace` tests only
  swapped `$HOME`, but Windows resolves `os.homedir()` via `USERPROFILE` —
  so on Windows the tests silently leaked the runner's real `~/.redlog` in
  and out, tripping length-of-1 vs got-2 rotation asserts. Swap both env
  vars per test. Unblocks the v0.6.68 / v0.6.69 Windows build.

## v0.6.69 — 2026-08-01
- **Marketplace UI wired end-to-end**: Settings ▸ 外掛市集 exposes the v1
  runtime that landed in v0.6.68. Three sub-tabs — Plugins (paste registry
  URL → fetch → install), Publishers (paste SPKI Ed25519 public key to
  trust a publisher; untrust; list pinned keys), Revocations (surfaces the
  local revocation cache so operators can see why an install was blocked).
  All calls go through preload `window.redlog.marketplace.*` — the core
  fetch/verify/install pipeline stays where the unit tests can hit it.
- **CI**: `.github/workflows/ci.yml` runs on every PR and main push —
  vitest (`npm test`) + build + Playwright-for-Electron (`npm run e2e`)
  under xvfb. Failures upload screenshots + playwright-report as artifacts.
- **Dual-ABI test hooks**: `pree2e` runs `electron-rebuild -f -o
  better-sqlite3` before Playwright launches so operators (and CI) don't
  have to remember which ABI the last command left better-sqlite3 built
  for. `pretest` already handled the Node → Electron direction.

## v0.6.68 — 2026-08-01
- **Plugin marketplace v1 core** (spec: [`docs/PLUGIN_MARKETPLACE.md`](docs/PLUGIN_MARKETPLACE.md)).
  Deliberately shipped without UI wiring — the runtime + trust primitives
  land first so the Settings panel can be layered on top without redesigning
  the security model mid-flight.
  - `src/core/plugins/publisher-trust.ts` — per-publisher trust store at
    `~/.redlog/trusted-publishers.json`; Ed25519 SPKI keys with rotation
    (multiple pinned keys per publisher), fingerprint helper, and detached-
    signature verify against ALL pinned keys (so key rotation doesn't break
    previously signed releases).
  - `src/core/plugins/marketplace.ts` — HTTPS registry client with hard
    caps (5 MB tarball, 1 MB index), fetch → sha256 verify → signature
    verify → validateManifest → id/version/publisher match → atomic swap
    into `~/.redlog/plugins/<id>/` with the previous copy snapshotted to
    `.<id>-versions/<oldHash>/` for rollback. Privileged plugins REQUIRE a
    verified signature; declarative plugins may install unsigned. Revocation
    list at `~/.redlog/plugins/revocations.json` blocks per-plugin or per-
    publisher.
  - `cli/redlog-sign.js` (new bin) — `keygen` writes an Ed25519 keypair
    (mode 0600); `sign <tarball> --key kp.json` computes sha256, signs it
    with the private key, sniffs `id`/`version` from the tarball's
    `plugin.json`, and prints a ready-to-paste registry index entry.
  - Coverage: 27 new tests (`publisher-trust.test.ts`, `marketplace.test.ts`,
    `redlog-sign.test.ts`) covering rotation, mismatched publishers, revocation
    both scopes, sha256 mismatch, privileged-without-signature rejection,
    unsigned-declarative accept, snapshot + rollback round-trip, and the CLI
    end-to-end (spawnSync). Suite now 248 tests.
- **E2E**: `e2e/project-flow.spec.ts` — three tests sharing one Electron
  launch: create+open a project (screenshot proof to
  `e2e/screenshots/project-opened.png`), Cmd+1..9 tab switch regression
  guard for the v0.6.67 focus fix, and `chain.verify({ full: true })` on a
  fresh project returns `ok: true`. Adds `data-testid` attributes to
  `App.tsx` view root and `ProjectPicker` outer container (attributes only,
  no logic touched). `playwright.config.ts` set to `workers: 1` because
  Electron's single-instance lock + port 6660 bind means parallel launches
  step on each other.

## v0.6.67 — 2026-08-01
- **Fix**: `⌘/Ctrl+1..9` nav shortcuts silently missed the very first press
  after launch. The renderer's `window.addEventListener('keydown')` only fires
  when the webview has keyboard focus, and a fresh Electron launch (or a
  project-picker unmount) can leave the window "active" at the OS level but
  focus-less. `windows.ts` now calls `win.focus() + webContents.focus()` from
  `ready-to-show`, so the first shortcut works.
- **Tests**: new coverage for the three v0.6.60–64 modules that shipped
  without unit tests — `cast-slice` (window slicing, ANSI strip, malformed
  lines), `target-extractor` (the `://`-scheme fallback that killed the
  `python -c "import json.dumps"` false positive), and `hooks-manager`'s
  broken-shell-hook detector. Suite is now 223 → 234 tests, 23 files.
- **E2E scaffold**: `e2e/smoke.spec.ts` + `playwright.config.ts` — one
  Playwright-for-Electron smoke test that launches the built `out/main`,
  asserts the first window title, and screenshots. Not wired to CI yet;
  `npm run e2e` after `npm run build`. `@playwright/test` added to
  devDependencies.
- **Docs**: `docs/PLUGIN_MARKETPLACE.md` — v1 spec draft (git-repo-as-registry,
  Ed25519 signing, two-step publisher-then-capability consent, revocation
  list, threat model). Not implemented; unblocks the next design pass.
- **Docs**: `docs/CLOUD_SHARE_BUNDLE.md` — v1 spec draft for post-engagement
  cloud share (R2 + Workers default with mandatory BYO-bucket, hard redaction
  gate before upload, 40-bit unguessable share URLs, magic-link auth). Also
  spec-only.

## v0.6.65 — 2026-07-31
- docs: agent hook plugin guide — three tiers (native API / SHELL wrapper /
  shell fallback), full Aider plugin skeleton, testing checklist. Anchors the
  answer to "how do I add support for a new AI agent".

## v0.6.64 — 2026-07-31
- Hook cwd config **inverted** from whitelist → exclusion list. Claude Code
  Bash calls default to being logged whenever RedLog records; Settings ▸ 整合
  lets operators opt paths OUT (personal notes, hobby coding, secrets).
- Settings UI: native folder picker for the exclusion list (`hookConfig:pickPath`).
- Shell hook auto-upgrade at startup — anyone still holding a pre-v0.6.47
  `pid: $$$` copy gets silently overwritten with the fresh bundled version.
  Fires a `system.hook_auto_upgrade` chain event when it does.
- Target extractor fallback requires `://` before running DOMAIN_RE — stops
  `python -c "import json.dumps"` and `source .../shell-preexec-hook.sh` from
  landing in the timeline as a target.

## v0.6.63 — 2026-07-31
- Layout: `html/body/#root { height: 100% }` cascade + App root + ProjectPicker
  root `h-screen → h-full`. Fixes the StatusBar / Timeline event log being
  pushed below the visible window edge by body zoom.

## v0.6.62 — 2026-07-31
- Layout: `body height: calc(100vh / var(--app-zoom, 1.1))` so `zoom: 1.1`
  doesn't overflow the viewport.
- Timeline: hardcoded 240 px detail panel / 160-180 px event log heights
  replaced with 45vh / 18vh / 22vh so tighter fonts don't push rows off.
- `session_end` events no longer suppressed as housekeeping — the
  "▶ Replay entire session" button needs them to anchor onto.

## v0.6.61 — 2026-07-31
- Test: assertions updated for the new `ssh user@host` → interactive pivot
  behaviour so CI stops failing on the intended change.

## v0.6.60 — 2026-07-31
- SSH → VPS coverage (three-part):
  - **A**: session-level replay — Timeline shell.session_end grows a
    `▶ Replay entire session` button that slices the full .cast, showing
    everything typed after an ssh line.
  - **B**: `ssh user@host` with no `-D/-L/-R` now fires a pivot event
    (`subtype: 'interactive'`, `via: host`).
  - **C**: `hooks/vps-deploy.sh` — `install / tunnel / uninstall` subcommands
    that scp the hook to a VPS and run `ssh -R 6660:127.0.0.1:6660` so
    remote commands hit the local chain through the reverse tunnel.

## v0.6.59 — 2026-07-30
- Claude Code hook: two-gate privacy filter — RedLog must be recording AND
  the cwd must match one of the user's declared paths before an event is
  sent. Managed through Settings ▸ 整合. **Inverted to an exclusion list
  in v0.6.64 based on user feedback.**

## v0.6.58 — 2026-07-30
- `hooks/claude-code-hook.sh` rewritten to read Claude Code's new stdin JSON
  contract (the CLAUDE_TOOL_* env vars have been gone for a while, so the
  hook silently no-op'd for months). Also fixes a bash `${VAR:-{}}` quirk
  that mangled the JSON. New event fields: `session_id`, `transcript_path`,
  `cwd`. Conversation content is deliberately NOT copied into the chain —
  transcript_path is a pointer for on-demand audit.

## v0.6.57 — 2026-07-30
- HUD pin (📌/📍) moved out of the top-right chrome and into a bottom-row
  action pair with the MARK button in the expanded panel.
- Dashboard `p-5 space-y-5` → `p-4 space-y-3` so the 快捷鍵 block stays in
  the initial view under the enlarged font/zoom.

## v0.6.56 — 2026-07-30
- Repo-wide `text-[10px]` → `text-xs` and `text-[9px]` → `text-[11px]`
  (155+22 occurrences) so hint text scales with the operator's zoom.
- HUD pass-through mode: window.setOpacity() replaced with per-element dim
  in the renderer so the external IP row stays fully readable while
  everything else dims.

## v0.6.55 — 2026-07-30
- Chain verify: NULL prev_hash on pre-v0.2 events treated as a legacy
  migration sentinel, not tampering. New events still get strict linkage
  checking.

## v0.6.54 — 2026-07-30
- Dashboard: `事件` and `證據鏈` cards merged (they always moved in
  lockstep). Drift now surfaces as a red "chain N ≠ events M" callout —
  itself a tamper signal.
- Screenshot dedup: dHash (difference hash) added on top of SHA-256 so
  the periodic capture doesn't spam the chain with clock-tick duplicates.

## v0.6.53 — 2026-07-30
- Chain verify walks four hash shapes (v0.1 / v0.2 / v0.6 / v0.6+null) so
  older projects don't report BROKEN just because the schema evolved.

## v0.6.51 — 2026-07-30
- HUD click-through mode (Settings ▸ HUD) — HUD stops receiving mouse
  events; opacity drops to a chosen level (default 40%).
- **Closes #7** — periodic screenshot: Off / 30s / 60s / 5m (Settings ▸
  資料). Existing SHA-256 dedup skips identical frames.
- CLI sanitize: `opts is not defined` crash fixed (missing `flags` rename).

## v0.6.50 — 2026-07-30
- Larger default text: html `font-size: 17px` + body `zoom: 1.1`. Settings ▸
  一般 exposes an interface text size control (100/110/120/135%).

## v0.6.49 — 2026-07-30
- Chain verify tries key-absent shape first, falls back to null-inclusive —
  reconciles the two ways monotonicNs was hashed across versions.
- Search shortcut ⌘/ replaced with `e.code === 'Slash'` + `⌘K` alias
  (macOS delivered `Unidentified` for `⌘/` and it never fired).
- Added `docs/RELEASE_CHECKLIST.md`.

## v0.6.48 — 2026-07-30
- HUD corner-snap keychord `⌘⌥+Arrow` → `⌘⇧⌥+Arrow` (macOS Sequoia's
  built-in window tiling was eating the two-key combo).
- `events.query` accepts `before?: number`; Timeline `loadMore` anchors on
  the oldest known event so auto-load actually walks back through history.
- Marks pin toggle relocated from every list row to the mark detail panel
  (low-frequency action).

## v0.6.47 — 2026-07-30
- **Reverts** the chain-embedded stdout capture (v0.6.44). TUI tools would
  blow the 256 KB cap in seconds and ANSI escapes made stored output
  unreadable.
- **Replaces** with on-demand replay from the asciinema .cast on disk —
  `readCastSlice()` in core, `POST /api/terminal/replay`, `▶ Replay stdout`
  button on shell.command_end.
- Fixes pre-existing `hooks/shell-preexec-hook.sh` `pid: $$$` typo — every
  command_start / command_end hook call was silently failing since v0.6.20,
  meaning the built-in terminal had no command timeline events for over
  two years. Also adds REDLOG_TERMINAL_ID env for round-tripping in
  payloads.

## v0.6.44 — 2026-07-30
- Timeline auto-load-more on left-edge scroll (audit #3).
- Terminal tab labels: `~/<cwd basename>` + red `✕N` when the last command
  exited non-zero.
- Marks: pin toggle + persistent order via localStorage.

## v0.6.43 — 2026-07-30
- HUD `⌘⌥+Arrow` corner-snap (multi-monitor-aware; later moved to
  `⌘⇧⌥+Arrow` in v0.6.48).
- CLI: `recording [status|pause|resume|toggle]` + `quickmark [list|add]`.

## v0.6.42 — 2026-07-30
- Loot panel: type filter chips + dedup toggle.
- Screenshots grid: trigger filter chips.
- Timeline: ↑/↓ walks the selected event across visible events.
