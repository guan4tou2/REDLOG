# Tasks

- [x] T001 Record failing shell-selection and stale-result tests, then implement.
- [x] T002 Record failing command proof tests beyond the recent display cap.
- [x] T003 Add project-bound command evidence query and IPC/preload use.
- [x] T004 Record failing HTTP-only/HTTPS-principal tests, then implement.
- [x] T005 External-first layout, explicit built-in fallback, optional web setup.
- [x] T006 Integrate and review free-model patch; update locales/contracts.
      The free-model copy was a strict subset of this branch (it lacked the
      detect-failed state and the pre-install `available` check) and was
      discarded. Hooks now emit `wsl_distro`, which the WSL connection check
      requires.
- [x] T007 Run targeted tests, typecheck, spec/architecture/i18n gates and build.
- [x] T008 Run affected Electron journey and record untested platform limits.
