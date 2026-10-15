# Release checklist

Use this checklist for the current installed-package policy. The former
v0.9-era UI names, fixed test counts and portable-launch checks are retired.
Record actual run IDs/results; never turn an untested platform into a pass.

## Prepare

- [ ] Merge the reviewed recording changes into main; prepare release metadata
  on a new branch. Never reuse or move an existing release tag.
- [ ] Match package.json, package-lock.json, README download names, CHANGELOG
  and docs/RELEASE-v<version>.md. Keep known limits in the published notes.
- [ ] Run the ordered repository gates from CLAUDE.md: typecheck, Spec Kit,
  architecture, i18n, then npm test. Read actual pass/skip/failure counts.
- [ ] Build and run the affected Electron journeys; tests must use the selected
  installed executable when claiming packaged evidence.

## Installed candidates

- [ ] Windows NSIS: clean precondition, actual install, own-profile first
  launch, PowerShell, HTTP/HTTPS, export/shipped verifier, strict no-skip gate
  and uninstall. The installer filename must match Windows update metadata.
- [ ] Linux x64 DEB: actual apt install, command stdout/stderr/exits, nc job
  control, PTY helper, pane rotation, HTTP/HTTPS, export/verifier/restart and
  uninstall. Retain its JSON report and candidate checksums.
- [ ] macOS ARM: strict final resource seal, isolated installed-app journeys,
  real missing-tool installation and HTTP/HTTPS proof. Ad-hoc sealing is not
  Developer ID signing, notarization or quarantined-download/Dock acceptance.
- [ ] Record remaining manual/native requirements separately in
  docs/PACKAGED-SMOKE.md and the release notes, including WSL and the full
  first-install stopwatch. Do not mark them passed from source/container tests.

## Publish and verify

- [ ] User authorization to publish is present; merge the release preparation.
- [ ] Push a new version tag at the intended main commit. The workflow must
  build that exact tag for macOS, Windows and Linux; no best-effort platform.
- [ ] Require the versioned NSIS, DEB, DMG, supplementary Mac ZIP and matching
  Windows updater metadata before creating one release. No portable/AppImage.
- [ ] Publish SHA256SUMS.txt for the actual downloadable asset names.
- [ ] Confirm the release exists, is public and has every required asset;
  download the published packages and checksum file and verify their hashes.
- [ ] Update the release/recording issues with the exact tag and remaining
  limitations. Publishing does not complete untested Spec Kit tasks.
