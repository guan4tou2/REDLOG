# Tasks: Remove the Plugin Code Host

- [x] T001 Add failing tests: retired keys refused, host and runner gone,
      `tailers` still privileged.
- [x] T002 Remove the host, its wiring and the services block.
- [x] T003 Delete the runner and its packaging entry.
- [x] T004 Refuse `exporters`/`monitors`; keep `tailers` privileged.
- [x] T005 Move trust-gate fixtures to `tailers`; drop the capability-check tests.
- [x] T006 Correct the tier comment and the user-facing documentation.
- [x] T007 Remove `searchEvents`; port its tests.
- [x] T008 Run the plugin suites, typecheck, the full suite and build; record
      verification.
