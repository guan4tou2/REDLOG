# Verification: terminal session rotation

Date: 2026-10-14. Source baseline: main 9f8bf28; remote main updated to
3d89ffc during the run. Feature status is Implemented.

## RED

New cast and rotation regressions failed before the implementation: the writer
and detach/resume lifecycle did not exist. Real Electron scrollback search
failed after >8 KB output and a picker/project round trip. A signed Electron
project switch exposed `signature invalid`: creating the same operator in a
new DB overwrote its global keypair. Key-reuse/partial-key regressions reproduced
this independently. Original RED logs are retained with the handoff artifacts.

## GREEN

Real SQLite/cast tests cover A→picker→B→A, independent chain verification and
exact byte hashes, one-hop continuation, boundary command attribution,
failed recording with persistent health, pause, fresh truncation budget,
10 panes, shutdown and exact orphan recovery. Cast writes handle partial writes
and report a null hash after a failed write. External shell pin tests retain
Spec 052's contract. Final gate counts are recorded in the delivery artifact.

## Operational Verification

Electron: the same real Zsh PID/cwd survives leaving to the picker and opening
another project. Picker commands/output enter neither project. Each project's
chain and recording replay verify; the outgoing cast has no incoming/picker
bytes. Search buffer finds an older marker after >20 KB output, across
navigation/project switches. The picker and pane show persistent not-recording
states; leave copy does not claim jobs close or require that acknowledgment.

The current scope was tested on macOS; native PowerShell/WSL and Kali desktop
acceptance remain in the installer matrix. A renderer reload retains only the
backend display tail, not the in-memory xterm scrollback; it is not a project
switch. Existing shell environment (including proxy variables/connections)
is retained, so a project switch does not reconfigure an already-running shell.

## Converge

Domain semantics: distinct pane/recording IDs, immutable source events, current
project cast offsets and local causal links. Origin locators contain opaque
project/recording/command IDs, never another project's cast path or event ID.
Output boundaries use PTY receipt time; producer emission time is unavailable.
Incoming cross-boundary completions are explicitly `partial` with
`output_disposition: project-boundary`; a removed producer buffer never retains
a `full` claim. A regression first reproduced the stale full claim.
No compatibility adapter, new framework or timeline redesign was introduced.

## Final local verification

The original completion gate had 352 Vitest files PASS, 4 files SKIP;
3,581 tests PASS, 23 SKIP. Final follow-up counts are in the delivery artifact. Typecheck,
verify:specs, verify:architecture and verify:i18n PASS on the non-shallow branch.
The latest source round has 17 other journeys PASS plus the updated rotation
journey PASS separately after correcting the driver's scrolling/key-mode input.
The final rotation journey uses actual keyboard input for redlog stop/start:
paused content is visible on screen but absent from the cast; resumed content
is present. The durable per-pane stop also survives a project rotation.

New RED: a stopped pane still wrote private bytes to its cast. The writer and
command gate now follow the shared enrollment state, and health/pane badges
reflect pause. An enrollment write failure is a persistent recording failure.
Native PowerShell/WSL and Kali desktop remain installer-matrix acceptance.

The installed macOS DMG also passes the live-shell rotation/privacy test.
The first combined round ran 7 package-backed journeys and 15 source UI
journeys; the latter direct launchers have now been corrected to honor the
packaged executable and assert app.isPackaged. Final installed counts and
SHA-256 are recorded in Spec 047 and the delivery artifact. Linux CI installs
and explicitly selects Zsh for the Zsh-control journey rather than invoking
redlog stop in Bash. Windows installation CI is a separate acceptance surface;
it does not run the POSIX-specific rotation journey.

Two loaded local rounds also exposed intermittent PTY output/window-size
failures; focused 25- and 67-test follow-ups passed. Their original observations
and diagnostics remain in the delivery record and #333. A later green full
run does not establish their retrospective root cause or native Kali acceptance.
The driver itself had a confirmed additional defect: repeating a prompt made
the next line appear complete with empty output (real Zsh RED). Per-line prompt
sequence markers now reject old redraws and retain late bytes. Harness,
transparency and 100-command checks: 30 PASS. This establishes the driver fix,
not a retrospective explanation for every original missing-output observation.
