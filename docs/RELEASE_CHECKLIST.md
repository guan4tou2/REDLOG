# RELEASE_CHECKLIST

Every release tags a new v0.6.x. Run through this list before pushing the tag.
Skipping something is fine when you know it doesn't apply, but never skip
silently — leave a `- [~] not applicable this release: <reason>` note.

## 0. Static

- [ ] `npm run build` clean
- [ ] `npm test` → 207/207 (or higher — update this number if suite grew)
- [ ] `diff <(jq -r 'keys[]' src/renderer/src/i18n/en.json | sort) <(jq -r 'keys[]' src/renderer/src/i18n/zh-TW.json | sort)` → empty
- [ ] No mojibake in i18n:
  `grep -P '\xc3\x82|\xc3\x83' src/renderer/src/i18n/*.json` empty
- [ ] `README.md` version references updated

## 1. Project picker

- [ ] Open app cold → project picker appears
- [ ] Create new project → picker closes, dashboard loads
- [ ] Recent projects list clickable, opens right one
- [ ] Pencil ✎ rename inline works, keeps id + path

## 2. Dashboard

- [ ] Version tag matches package.json
- [ ] Event count matches DB (`redlog-cli status`)
- [ ] IP safety banner shows external + internal IP
- [ ] Capture health rows: shell hook / mitmproxy / Claude Code hook /
      RedLog terminal all have a state (not "unknown")
- [ ] Number cards clickable → jump to matching panel

## 3. Timeline

- [ ] Lane strip renders (Shell / 代理 / HTTP / 中繼跳板 / 標記 / 戰利品 / 系統)
- [ ] Clicking a shell command_end event opens detail panel
- [ ] Detail: **▶ Replay stdout (from .cast)** button appears for
      builtin-terminal command_end, shows sliced output
- [ ] ↑/↓ walks selected event across visible events (audit #5)
- [ ] Escape closes detail panel
- [ ] Scroll left to earliest → loadMore auto-fires (audit #3),
      older events appear
- [ ] Alt-click lane label → solo lane
- [ ] Cluster popover click → timeline scrolls to that event
- [ ] Copy JSON respects mask/reveal state

## 4. Terminal

- [ ] `+` new tab; tab counter monotonic (Shell 1 / Shell 2 stays unique)
- [ ] Command runs, `whoami` prints
- [ ] Command_start + command_end both hit DB with `source=builtin-terminal`
      and `terminalId` set (verify via API)
- [ ] Tab label shows `~/<cwd basename>` after first cd
- [ ] Tab label shows red `✕N` when last exit != 0
- [ ] ⌘T new tab, ⌘W close, ⌘⇧] next, ⌘⇧[ prev
- [ ] Dead tab: click ↻ → in-place restart (label preserved, new PID)
- [ ] Font ⌘+ / ⌘-
- [ ] Buffer search ⌘F: type query, Enter next, Shift+Enter prev
- [ ] .cast file exists in `<projectDir>/casts/` after session

## 5. Screenshots

- [ ] Panel loads
- [ ] "立即擷取" button captures a screenshot
- [ ] Grid shows thumbnail, click → full-size overlay, Esc close
- [ ] Trigger filter chips appear when 2+ distinct triggers
- [ ] Delete button: only JPEG deleted, event row stays,
      `system.screenshot_deleted` audit event appears

## 6. Targets

- [ ] Populated from shell command detectedTarget
- [ ] 全部 / 範圍內 / 範圍外 filter chips work
- [ ] Click target expands evidence rows
- [ ] Out-of-scope target: "+ 範圍" pill appends to config.scope.targets,
      target reclassifies

## 7. Scope

- [ ] Configured target list shown; violation events listed
- [ ] Violation row click → jumps to Timeline
- [ ] Export button writes JSON to file

## 8. Loot

- [ ] Loot events grouped by source event
- [ ] Type filter chips (aws_key / flag / jwt / …) narrow list
- [ ] Dedup toggle collapses duplicates
- [ ] Card click → jump to timeline

## 9. Marks (findings)

- [ ] Create via + button OR ⌘M shortcut
- [ ] Mark list clickable → detail panel opens
- [ ] Detail: pin button ★/☆ toggles, pinned marks float to top,
      list row shows small ★ indicator
- [ ] Edit / Delete work
- [ ] Search input appears when marks.length >= 5, filters live
- [ ] Export button writes JSON

## 10. Search (⌘/)

- [ ] Search panel opens
- [ ] Type ≥1 char → results show
- [ ] Type filter chips filter by agent_type
- [ ] Click result → "Open in timeline" jumps back to Timeline focused on that event

## 11. HUD (overlay)

- [ ] Right side of screen, shows recording + safety + external IP
- [ ] External-IP change flash (turn Wi-Fi off/on)
- [ ] `⌘⇧⌥ ↑` / `→` / `↓` / `←` snap to TL / TR / BR / BL
- [ ] Font scale + IP emphasis toggles reflect settings
- [ ] Hide/show via tray menu

## 12. Settings

- [ ] All tabs load (Engagement / Operator / Scope / Redaction /
      Overlay / Hooks / Plugins / Advanced)
- [ ] Auto-save works (no explicit Save button; edit → wait → reload → persists)
- [ ] Operators: add / rename / rotate token / revoke
- [ ] Scope: add pattern → violation flow triggers next command_start
- [ ] Plugin: enable → reload → tools appear in MCP list

## 13. CLI (`redlog-cli`)

- [ ] `whoami` returns operator info
- [ ] `status` prints event count + IP + capture health
- [ ] `mark "test" --severity info` inserts, appears in Marks
- [ ] `log terminal --data '{"subtype":"note","command":"cli-test"}'` inserts
- [ ] `search test` returns marks
- [ ] `recording pause` → status = paused; `resume` → recording
- [ ] `quickmark list` matches Marks panel
- [ ] `quickmark add "cli mark" --url https://example.com`
- [ ] `replay <event_id>` prints stdout slice for a shell.command_end
- [ ] `screenshot` triggers capture
- [ ] `chain status` prints length + last anchor
- [ ] `chain verify` returns OK
- [ ] `chain verify --full` walks entire chain, no gaps
- [ ] `chain anchor` submits to OpenTimestamps
- [ ] `sanitize --dry-run --event-ids <id> --reason "test"` prints diff
- [ ] `export bundle` writes to disk, manifest valid

## 14. Chain integrity

- [ ] Every command_start followed by matching command_end (for internal terminals)
- [ ] `chain verify --full` clean
- [ ] Hourly anchor timer fires (check anchors table growth)

## 15. i18n

- [ ] Switch language via Settings → both languages render without missing key `[foo.bar]`
- [ ] No CJK mojibake in either lang

## 16. Deconfliction

- [ ] Webhook config accepts URL
- [ ] `redlog-cli deconfliction test` posts a probe

## 17. Cross-cutting

- [ ] Recording pause: no new events added while paused, resume works
- [ ] Kill app mid-session: on relaunch, project reopens cleanly,
      chain not corrupted
- [ ] Uninstall + reinstall via DMG: `~/.redlog/projects.json` and
      project dirs preserved
- [ ] Windows portable exe: at minimum, launches (skip if not shipping this release)

## Handling "not applicable"

If a section can't run this release (e.g. Chain anchor test requires
internet), tick with `- [~] not applicable: <reason>`.

## When something fails

Don't ship. File the failure as a task, fix it in a follow-up commit,
re-run just that section, then continue.
