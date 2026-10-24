# Internal candidate acceptance — 2026-10-24

## Provenance

Baseline product: c0f2af7d, 0.18.3, Electron 44.4.1, macOS arm64. This is a
local internal candidate, not a newly published 0.18.3 release. The initial DMG
was mounted read-only and copied to an isolated install directory; the operator's
/Applications installation, shell profile and real projects were not replaced.

Initial DMG SHA-256:
`a27965bd538d8f30cf941f21347b93bf394a53d7c5e799f3992d8111e0305794`.
Packaged resources and deep/strict codesign verification passed. Ad-hoc sealing
is not Developer ID signing, notarization or a network-download Gatekeeper test.

Artifacts/reports for this run are under
`/private/tmp/redlog-internal-20261024/`; synthetic HOME directories are also
used by the existing packaged suites. No private conversations or real secrets
are test inputs. The initial candidate is superseded by the layout follow-up
below; do not distribute it as containing that later change.

## Initial installed candidate

Six suites, 17 distinct cases: dependency cancellation, first-run, packaged
100-command integrity, explicit session helper, actual capture/export/restart,
and terminal project rotation. The first run had 16 passes and one stale
settings-route assertion. Corrected that assertion, reran the complete set:
**17 passed**, no retries/skips or not-exercised annotations. The strict smoke
report gate accepted packaged-final.json.

Actual checks include command/output/exit/cast, 100 ordinary Zsh commands
(50,044 ms in the final run), real managed HTTP traffic, HTTP/HTTPS nonce
checks using a test-profile CA without -k, evidence bundle bytes and the shipped
verifier, indexed recording search after restart, installing/uninstalling the
explicit session helper, separate project recordings and canceling only the
test install process. They are automated installed-app observations; they do
not prove all user-browser trust stores or a fully clean operating system.

## Operator-reported partial-state layout

The screenshot exposed an imbalance missed by the earlier overflow-only checks.
The source follow-up moves work actions to the header, recent evidence below
terminal capture, removes the enclosing duplicate card/title and shows one leave
action at a time. Source first-run journey: **13 passed**, including relative
geometry at 1600×900 and 800×600. Related UI/copy tests: **67 passed**.

Native source-build check: create Internal-Layout-20261024 via the UI, install
the Zsh adapter into isolated HOME, open a real Zsh PTY, enter the displayed
canary, then stdout/stderr and exit-7 commands. The wide native window showed
verified terminal / pending HTTPS, header Start work, eight recent rows under
terminal capture and the separate web form. The original project and shell
profile were untouched. Quit confirmed stopping the test proxy; process exit 0.

After native Window → upper-left resizing, capture returned an apparently stale
cropped frame, then ScreenCaptureKit -3812/noWindowsAvailable. This is **not** a
native narrow-layout PASS or a proven product defect. The user was asked to
confirm desktop availability; automated narrow geometry remains separate.

## Cross-platform initial runs

- Windows NSIS: [40002209207](https://github.com/guan4tou2/REDLOG/actions/runs/40002209207).
- Linux DEB: [40002215333](https://github.com/guan4tou2/REDLOG/actions/runs/40002215333).

Both ran c0f2af7d and failed the same installed-smoke assertion expecting the
old captureControl route instead of hooks, after actual install/capture/export
steps. These failed runs remain failed evidence; the repaired test needs a new
revision's completed workflow result. Ubuntu runner acceptance does not become
manual Kali desktop acceptance. Native Windows-to-WSL is a separate environment.

## Remaining boundaries

Latest-layout package and repaired cross-platform results are recorded below
when completed. Spec 062 remains Draft: T008–T013 do not close from this bounded
run. Real downloaded/quarantined launch, browser/system CA trust, native WSL,
physical disk-full recovery, hours-long interactive use and actual version
upgrade are not certified by the synthetic/automated cases above. No extra
feature backlog or new capture modes are introduced to hide those limits.

After the source layout change: typecheck, Spec Kit, architecture and i18n
gates passed; full Vitest run **4,167 passed / 28 explicit skips**, no retries.
The unchanged capture/storage behavior is covered by that run, not by treating
the earlier DMG as if it already contained the new layout.

## Latest layout candidate and real preservation failures

d6b53d7e DMG was separately mounted/copied and verified. Its 18-case installed
suite passed the strict report gate (no skipped/not-exercised cases), including
the new layout geometry. DMG SHA-256:
`06e117eca03cb483f45b410648c089fe56d508d011130975f689205193910f40`.
This candidate is superseded by the toast repair below, not silently relabeled.

The installed export journey now supports REDLOG_PACKAGED_APP and asserts
app.isPackaged. Making only the disposable exports directory mode 0555 produced
real EACCES; the dialog/format/range stayed, no artifact was created, restoring
permissions and retrying delivered a matching manifest/count and retained every
pre-failure source ID. Five cases passed on d6b53d7e.

Adding the approved-attachment disappearance case exposed a real UI defect:
queued success/error notifications (z=100) intercepted normal export clicks above
the z=91 modal in the 800px window. The test failed at a normal click; no force
or dismissal workaround was added. Move non-modal toasts below modal backdrops,
keeping errors persistent and announced. Source-build rerun: **six passed**,
including temporary attachment move/restore, error visibility, retained selection
and source bytes, re-resolve and project-switch rejection. All permissions and
attachments are restored in finally. This is not a simulated or physical ENOSPC,
and the POSIX permission case explicitly excludes Windows ACL semantics.

The final deliverable must be rebuilt after this repair and carry its own
productCommit/hash/results; neither preceding DMG is the final package.

Toast repair push gates: typecheck → Spec Kit → architecture → i18n → full
Vitest all passed, **4,167 passed / 28 explicit skips**, no retries. The two
d6b53d7e native x64 installer workflows completed successfully:
[Windows NSIS 40005124823](https://github.com/guan4tou2/REDLOG/actions/runs/40005124823),
[Linux DEB 40005128921](https://github.com/guan4tou2/REDLOG/actions/runs/40005128921).
These certify that preceding revision; final toast-repair workflows must be
recorded separately. An attempted local download of the superseded Linux
artifact stalled and was stopped; workflow success is not a local-file/hash
verification of an installer that was not downloaded.


## Installed follow-up and native layout completion

The 95a0acb1 installed 24-case run was **21 passed, 1 failed, 2 not run**;
it did not pass the strict gate. Unlike the earlier slower run, two JSON
exports happened within the same second. The second overwrote the existing
writable file, which a 0555 directory does not prevent. Four deterministic IPC
regressions (JSON/NDJSON/HAR/Timeline) reproduced identical destination paths;
exclusive file creation and suffixes now preserve the first artifact/manifest.
The preceding candidate is marked failed, not handed out as accepted.

95a0acb1 native installer workflows themselves passed:
[Windows NSIS](https://github.com/guan4tou2/REDLOG/actions/runs/40006664337),
[Linux DEB](https://github.com/guan4tou2/REDLOG/actions/runs/40006668304).
They did not select the failing export-permission case and do not override it.

After the user unlocked the desktop, native installed-app inspection completed
on isolated HOME/profile with a newly created Layout-Narrow-20261024 project.
A real enrolled Zsh canary changed terminal proof to verified while HTTPS
remained unverified. At the OS quarter-screen size (1750×1096 capture pixels,
roughly 875×548 points), setup stacked terminal → recent evidence → HTTPS;
Start work stayed in the header. Page Down exposed all HTTPS setup controls,
the timeout explanation and fallback sources without horizontal clipping.
The OS Fill layout restored two columns, recent evidence beneath terminal and
Start work at the top. Settings shell rows stacked with reachable actions;
the plugin empty-state textarea fit its pane; export cancel/confirm stayed
within the small window. Escape returned to settings. This supersedes only the
earlier unreliable narrow capture, not the open global-shortcut/update gates.
Native captures are local at /private/tmp/redlog-internal-20261024/:
native-settings-narrow.png, native-setup-narrow-bottom.png, native-setup-wide.png.
Some CUA screenshot/scroll attempts returned noWindowsAvailable; keyboard
scrolling plus successful native screenshots established the observed states.

Removed seven duplicate regex assertions from timeline-geometry-units;
remaining width integration guards are timeline-track-wiring. Behavior remains
covered by timeline-geometry, timeline-time-map and timeline-presentation.
The former title-bar dropdown ancestry check now tests the current fixed
export dialog's viewport bounds and unobstructed confirm hit target. Platform
skip documentation matches the actual POSIX installer tests; no required
producer, permissions, evidence-integrity or native-platform case was deleted.

Collision/test cleanup verification: typecheck, specs, architecture, i18n and
build passed. Full native-permission Vitest: **4,164 passed, 28 explicit skips**
(116.16 seconds). Existing four source journey files: **37 passed** (57.6 seconds),
including all-view 100–200% zoom controls, 800×600 scope, 1600/800 setup,
plugin width and all six real export cases. The interrupted sandboxed unit
attempt is not counted. Replacement installed candidate remains a separate gate.


## Accepted macOS internal candidate — 69bd2213

Built from product commit `69bd2213599ff6de0336d3364e13184ab919a344` after the collision repair. Mounted the
DMG read-only, copied RedLog.app into an isolated install folder, detached the
image, and verified its resource contract and deep/strict ad-hoc signature.
Installed run: **24/24 passed** in 1.6 minutes; strict JSON gate passed with
no skipped, flaky or not-exercised case. Includes all six export recovery
cases, first-run layout, dependency cancellation, five PTY helper sessions,
100 ordinary real Zsh commands (49,600ms journey time), export/verify/restart,
and live-shell project isolation. The journey time is not per-command latency.

- DMG SHA-256: `23963815c2957e5a45a911bb444a6469825cc03e023e4e9f5b76df513791159c`
- Installed app.asar SHA-256: `41fbf787c13ce91fc8ca8c4c3caea102945ea6e28afa81a1890b53005a7b48c9`
- Raw report: `/private/tmp/redlog-internal-20261024/69bd2213-smoke.json`
- Local deliverable: `dist/internal-20261024-69bd2213/`

This supersedes the failed 95a0acb1 Mac candidate. Prior Windows/Linux green
runs remain evidence for 95a0acb1, not this later collision repair. This local
Mac candidate is not a published release, Developer ID identity, notarization,
Gatekeeper download acceptance or completion of T008–T013.


## UI/CSS follow-up — 0f79e841 → 46f5437c

Project/operator/profile fields moved intact from appearance to Project & scope,
including their field-search routes. Ordinary compact actions reuse Button;
labels can wrap and toggles expose pressed state. List/evidence settings use
available width; dashboard placeholders match its vertical structure. Combined
800×600, 140% UI scale and 200% Electron zoom reproduced controls beyond 500px
in a 400px effective viewport. Header reflow and caption shrink now preserve
all actions/uptime in 400px, in both locales.

Native installed 0f79e841, isolated HOME/profile:

- OS quarter-window (1750×1096 captured pixels, approximately 875×548 points)
  at UI 140%: two header rows, reachable evidence actions, appearance controls
  wrap, settings switch to their existing dropdown. Readonly engagement ID,
  operator fields and profile action remain reachable by scrolling.
- Field search for 操作員 leads to Project & scope and highlights the field.
  Edited the test operator to Operator Layout Review, left/re-entered and read
  it back, then restored Operator. Restored UI scale to 100% before quitting.
- JSON export dialog keeps cancel/confirm visible at that small/large scale;
  native Cancel returns to settings and restores opener focus. Actual execution
  and recovery are covered separately by the six installed export cases.
- OS Fill: plugin sample input uses available pane width, header returns to one
  row. No claim of manual all-page/all-state coverage.

Native captures: `/private/tmp/redlog-internal-20261024/ui-polish-native-appearance.png`,
`ui-polish-native-project.png`, `ui-polish-native-export.png`. These are local
test artifacts, not proof of Windows display-DPI behavior.

Switching categories after scrolling through project fields revealed a further
friction: plugins inherited that scroll offset and hid their heading/actions.
The amended source journey failed first, then passed after a three-line tab
scroll reset ahead of field-search positioning. Final product **46f5437c**:
ordered gates + build passed, **4,165 unit passed / 28 skips** (108.96s),
**52/52 source UI passed** (1.7m), **20/20 installed passed** (29.0s), both
strict reports passed. The initial complete unit attempt had one unchanged
attachment-focus failure; isolation and two later full runs passed. No retry
or skip was added to hide it. Earlier incomplete fixtures were repaired.

Mounted the final DMG read-only, copied to an isolated install and detached it.
Resource gate and deep/strict ad-hoc signature passed.

- Product: `46f5437c5a85836186cf828e86fab80caccbca6d` (see candidate.json for authoritative full SHA).
- DMG SHA-256: `9909a387d811be437ea844eac1746e9a1b2e6a284f4a210cb7505a2f1f97de97`
- app.asar SHA-256: `73a9084a960d5834a878362809cf92e14b4421b5c146366ac7036f1de00633be`
- Deliverable: `dist/internal-20261024-46f5437c/`
- Reports: `ui-polish-final-e2e.json`, `46f5437c-smoke.json` in the same tmp root,
  with copies in the deliverable.

The desktop locked before final native recheck of category reset and field
search on 46f5437c; user unlock requested. Candidate is **automated-passed,
final-native-pending**; T063 remains open. T008–T013, actual update, Gatekeeper
download and native Windows/WSL/DPI acceptance remain open. No release/push.
