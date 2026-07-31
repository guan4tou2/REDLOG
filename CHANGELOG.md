# CHANGELOG

RedLog release history. Each entry links to the tag; run `gh release view v0.6.x`
for full commit body + generated notes.

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
