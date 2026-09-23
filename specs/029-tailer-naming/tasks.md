# Tasks: Tailer Naming

- [x] T001 Rename the PowerShell follower: file, functions, config key, i18n.
- [x] T002 Split the Claude adapter into `adapters/claude-code.ts` and the
      registration into `agent-tailer.ts`; drop `startAgentTailer` and the
      host re-exports.
- [x] T003 Rename test files; point imports at the host and the adapter.
- [x] T004 Add the naming guard test; confirm it fails on the pre-change tree.
- [x] T005 Correct `docs/TESTING.md` §2.12 and design-doc file names.
- [x] T006 Run the suites, typecheck, the full suite and build; record
      verification.
