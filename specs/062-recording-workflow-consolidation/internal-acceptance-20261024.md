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
