# Optional AI packages and UI review — 2026-10-24

Status: bounded implementation and Mac review completed; Spec 062 remains Draft. This record distinguishes source/unit/Electron/native evidence; it does not certify every platform or every error state.

## Accepted design

- Official AI capture is optional. The app includes inert offline packages; installing copies only the chosen package. A valid installation alone never grants project permission.
- Provider name, source-directory defaults/environment mapping and parser live in the package. Core owns authorization, from-now boundaries, sidecars, ingestion, health and evidence preservation.
- One source entry owns install/remove/recovery, authorized working directories and project recording. Generic Plugins does not expose a second official AI switch.
- Source path, authorized cwd and copied project evidence remain separate. Originals are read-only; uninstall never deletes original transcripts or captured evidence.
- Claude Code is first, Codex second. Existing OpenCode support is retained without extending its format coverage.
- Ordinary workflow uses names, controls and state. Paths/removal are expanded on demand; required scope-change and removal consequences remain explicit.

## File ownership

| Location | Owner and lifecycle |
| --- | --- |
| `optional-plugins/<provider>/` | Maintained package source: manifest and parser. Not a runtime installation. |
| `out/optional-ai/<provider>/` | Independent build output; copied to installed app `resources/optional-ai/`. Never auto-discovered as an active plugin. |
| `~/.redlog/plugins/<package-id>/` | Explicit installation: managed manifest/receipt and checksum-matching `adapter.cjs`. Loaded only for an authorized source. |
| Vendor transcript directory | Vendor-owned original content. Explicit project override → absolute vendor environment root → package default. |
| Project `config.yaml` | Allowed working directories, optional source directory, installation receipt and activation boundary. |
| Project `agent-transcripts/` | Captured evidence; governed by retention/export, not by plugin uninstall. |
| Installed app resources | Immutable application assets, hooks and inert optional packages. |
| `~/.redlog/` runtime files | Local hook connection/identity/spool/runtime state. No filesystem migration in this change. |
| Electron `userData` | App preferences/update state/cache, separate from engagement evidence. |
| `~/.mitmproxy/` | Machine CA/tool state, separate from project evidence. Private keys are not project exports. |

Source-position references: [Claude directory](https://code.claude.com/docs/en/claude-directory), [Codex configuration](https://developers.openai.com/codex/config-basic/). GUI launches may not inherit environment variables exported only in a shell; source settings therefore retain a native folder picker.

## Build and loading contract

Existing Vite tooling builds each provider independently, with no new runtime dependency. The package manager validates identity/API, relative default paths, expected managed files and parser bytes against the app-supplied package. It does not execute packages during discovery/install. The host supplies shared filesystem watching; a package cannot acquire recording permission by declaring a cwd or source path. Generic third-party in-process executable plugins remain refused.

Verification must cover uninstalled/installed-but-off/active/stopped/removed states, modified code, missing packages, path reset between projects, original-byte preservation, and new package discovery without a core provider list. App updates and separate plugin distribution are not implemented as a new marketplace/update service.

## Latest user updates preserved

Final inspection HEAD: `52b80c80`. The user’s Transcript incremental merge/anchor changes, moved navigation/export journeys, merge of main’s PowerShell durability and HTTP start-failure repair, and fractional-width geometry assertions are preserved. Only the AI recovery scenario in the shared capture-settings test is changed by this work; its updated geometry assertions remain intact. Unrelated `package-lock.json` and `mitm_mcp_traffic.db` are not part of this work.

## Native page review

Native review uses `/private/tmp/redlog-ui-placement-20261024/` and actual packaged `RedLog.app`. No real AI transcript or operator project is read. Fresh final project: `UI-review-final-20261024`. CUA keyboard, native folder pickers, menus and clicks were used; this is separate from the automated Electron journeys below.

Wide: 1400×900 logical (2800×1800 raster). Native Window → Move & Resize produced 875×1095 and 875×548 logical windows. Corner-drag attempts did not reliably resize and are not counted. This is representative desktop coverage, not every page at every size or a mobile-browser claim. Screenshots were inspected in the tool session.

| Surface | Observed coverage | Result / limit |
| --- | --- | --- |
| Project picker | Wide empty/create | Created the isolated project manually. Empty helper repeats the form’s purpose. |
| Dashboard / initial setup | Wide unverified setup; narrow after evidence | Core source state, setup recovery, unverified HTTPS and work evidence remain reachable. Health actions remain distinct from first-run setup. |
| Command/terminal settings | Wide and 875×548 | Cards wrap without lost actions; foreign platforms stay folded. Duplicate mitm setup entry and unequal shell-description detail remain recommendations. No real profile installed. |
| Browser/HTTP settings | Narrow top and bottom, disclosures | Controls reachable; browser/verification still deserve priority above binding/CDP tuning. No CA trust/removal or network changes executed. |
| Other capture sources / AI | Wide and narrow, install/active/reset/remove | Claude alone installed; real native picker selects authorized cwd and a separate custom transcript root. New prompt/reply/tool I/O received. Reset stops capture pending reconfirmation. Removal preserves captured conversations. |
| Screenshot source controls | Same source page | Scheduling separate from manual capture, selected intervals exposed, image tuning folded. No real desktop capture performed. |
| Plugins | Narrow empty | Official AI has no duplicate machine switch. Third-party sample tester still occupies initial empty-page space. |
| Project/scope settings | Narrow top and bottom | Project/identity/profile fields reachable, independent category/content scrolling. No scope semantics changed. |
| IP/network settings | Narrow top | VPN rows wrap, known security boundary remains. Real network configuration unchanged. |
| Loot settings | Narrow top | Rule/status controls fit. Builtin English IDs/confidence remain unnecessarily technical. |
| Retention | Narrow | Numeric controls bounded; destructive retention consequence retained. No cleanup executed. |
| Integrity | Narrow populated, real verify | Full chain of 24 events verified. Found misleading anchor status copy: backend checks covered prefix, not current head. Corrected locales without changing crypto. |
| Appearance/language | Narrow | Field groups readable; no operator profile changed. |
| HUD settings and window | Wide expanded HUD; narrow settings | Existing scale stops align; default remains enabled. Transient resize screenshot was not a persistent clipping defect. HUD hidden only in disposable profile for main-window inspection. Global shortcut delivery not retested. |
| About/updates | Narrow | State/version/debug location visible. No real update/defer/restart flow executed. |
| Timeline | Narrow populated | Toolbar accessible and timeline canvas intentionally pans horizontally; list below stays readable. Did not exhaust large dataset/focus states. |
| Search | Narrow empty, results, no-match | Native search found four AI records including output tail. No-match input remained usable. Internal `agent`/`system` facet names remain a recommendation. |
| Transcript | Wide and narrow populated/expanded | Three exchanges; prompt/reply and full tool input/output readable. Removing provider does not remove prior conversation evidence. |
| HTTP history | Narrow empty | Heading/filter/status controls fit; source-settings recovery available. Populated body/error states covered by prior records, not counted as this native pass. |
| Built-in terminal | Narrow populated | Entered `printf` manually; expected output visible and present in exported evidence. External terminal/profile installation not exercised. |
| Screenshots | Narrow empty | Direct action available; duplicate action and long empty paragraph remain a recommendation. No private screen image captured. |
| Targets | Narrow empty | Filter controls fit; title and paragraph duplicate how discovery works. Populated host/pagination not exercised natively here. |
| Scope/evidence view | Narrow unconfigured | Correct unconfigured state and settings recovery; evidence count visible. |
| Loot view | Narrow empty | Filters remain available; empty copy could be shorter. No actual credential generated. |
| Bookmarks | Narrow empty | CDP disconnected state explicit. Non-evidence boundary retained; no CDP session started. |
| Export | Narrow dialog top/bottom; actual JSON | Scroll area and fixed actions reachable. Scope-unset warning visible before export. Artifact read-back contains prompt/reply/full tool I/O and native terminal output, excludes preactivation history. |
| Marker | Narrow open/cancel | Focus at title; inputs, severity, immutable-field warning and action fit. Canceled; no screen capture. |

Native JSON: `native-final-home/.redlog/projects/ui-review-final-20261024-mvm4g2pi/exports/redlog-2026-10-24T08-34-17.json` under the isolated review root. Contains 27 selected events. `NATIVE_PLUGIN_NEW_MESSAGE`, `NATIVE_PLUGIN_INPUT`, `NATIVE_PLUGIN_OUTPUT` and `NATIVE_UI_TERMINAL_OK` present; `OLD_NATIVE_HISTORY` absent. After uninstall, zero `official-ai-*/adapter.cjs` remain in that profile; the captured Claude sidecar remains (695 bytes, SHA256 `d29b56a869fc31875c0e29bc4ab41026cd7449c94ac7d89e5e7a6e1408eb778d`). Original/sidecar byte preservation across removal is asserted by installed journeys. The native app was quit normally.

## Remaining recommendations, ordered by operator friction

These are findings, not silently implemented features or reasons to block optional AI capture.

1. **One web setup entry.** Terminal settings still include mitmproxy even though browser/HTTP has a dedicated page. Keep web lifecycle and verification there; terminal source rows should use the same operator-level install/start/verify language for Bash/Zsh/PowerShell, while implementations stay separate.
2. **Common web actions first.** Show source state, start/browser choice and HTTPS verification before executable/bind/port/CDP tuning. Keep CA trust/removal consequences explicit; do not auto-change trust as a layout fix.
3. **Shorter empty states.** Screenshots, Targets and Loot repeat their heading/state in paragraphs. Use one short next action or state. Bookmarks must still say they are editable and not evidence; compress this boundary rather than deleting it. No new hint boxes.
4. **Human-readable domain labels.** Search facets show `agent`/`system`; builtin loot rules show technical IDs plus untranslated explanations. Localize visible category/confidence names, retain canonical IDs in evidence/details.
5. **Disclosure for plugin sample testing.** It occupies the empty third-party Plugins page even without installed rules. Fold the existing tester rather than creating another tester page or moving its mixed contribution behavior into Loot.
6. **Elapsed-time semantics.** Current tooltip truthfully describes project age. A session timer needs a real session boundary; do not merely rename that number.

No per-provider AI workspace, plugin store, LLM classifier, data-folder migration or new navigation layer added. Custom project storage placement and separate plugin update distribution remain future decisions. The new package format deliberately does not adopt older receipt-only development installations; conflicts preserve files and expose folder recovery.

## Verification and limits

- RED: resolver ignored vendor roots/invalid explicit roots (2 failures); generic Plugins exposed official AI switches (1 failure). New fixture tests also cover an additional package without core catalog changes, modified code refusal and literal custom paths.
- Ordered final implementation gates: typecheck, specs, architecture, i18n, unit all passed. **4,188 passed / 28 existing skips; 418 test files passed / 5 skipped** (117.84s). Log `/private/tmp/redlog-placement-unit-final.log`. Initial sandbox workers stalled; that interrupted environment run is not counted as success. Initial stale source-layout assertions were corrected and the normal full run then passed.
- Source journeys: 10 distinct cases passed across the affected AI/installation/capture-settings/Transcript files. One initial recovery test expected the deleted generic official switch; its updated source-owned recovery scenario passed on rerun. Do not describe this as an uninterrupted 10/10 run.
- Actual packaged app: **3/3 AI journeys passed** (25.3s), including Claude/Codex full tool I/O/search/JSON, no parser load before authorization, unload at stop/removal, receipt/reinstall boundaries, project-root reset and preserved originals/sidecars. Log `/private/tmp/redlog-placement-installed.log`.
- Main bundle excludes provider parser symbols. Optional package resources, checksum validation and strict/deep ad-hoc signature verified on the packaged candidate. The app is a local Mac arm64 candidate, not a notarized/released installer.
- Native review discovered only an anchor status wording defect in this bounded implementation. After its locale fix, typecheck/spec/architecture/i18n and **23 focused integrity/copy/settings/i18n tests passed**. Final closeout package passed resource/signature verification and 3/3 installed AI journeys (26.6s); latest user geometry and related capture settings passed 5/5 (15.1s). Native final package verified 32 events with the correct older-anchor wording. Logs and exact candidate path are in verification.md.
- No live vendor model, paid/free external model, real account or private conversation used. Synthetic format coverage does not certify every current vendor JSONL variant, desktop/web client, images/attachments, hidden reasoning, source rotation or provider update.
- Windows/Linux installers, real external shell profiles, global HUD delivery and update/defer/restart remain the separate T008–T013 acceptance work. Spec 062 is not Verified by these results.
