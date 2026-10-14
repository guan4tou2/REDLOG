# Tasks: Capture Setup Wizard

- [x] T001 Keep the project picker free of runtime readiness surfaces.
- [x] T002 Add Prepare → Prove inside FirstRunView with automatic advancement
  when the selected capture dependencies are present.
- [x] T003 List only missing relevant tools and keep failed/unknown checks
  distinct from prepared state.
- [x] T004 Use one installation UI and existing runtime.install IPC; retain
  error, manual command, prerequisite and retry in the row.
- [x] T005 Recheck tool availability after installation; never verify capture
  merely because installation exited successfully.
- [x] T006 Route command and HTTP missing-tool actions back to preparation.
- [x] T007 Allow skipping/leaving either phase without gating other views or
  persisting a per-install completion flag.
- [x] T008 Reopen setup from Capture Health in recorded and failed-health
  states, preserving project/evidence/terminal identity.
- [x] T009 Add focused regression tests for installation and setup recovery.
- [ ] T010 Complete native clean-host installation acceptance on Windows/WSL
  and macOS download quarantine/Gatekeeper. Local container/DMG-copy evidence
  does not satisfy this task.
