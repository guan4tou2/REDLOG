# Feature Specification: Remove the Plugin Code Host

**Feature Branch**: `refactor/remove-plugin-code-host`
**Created**: 2026-09-23
**Status**: Verified
**Input**: Remove the isolated plugin code host that has run nothing since v0.12, and the parts of the product that exist only for it — including user-facing documentation that describes an isolation RedLog does not provide.

The 🔴 plugin tier was designed to run plugin code in an isolated Electron
utility process behind a capability-scoped `ctx` API. Its only code
contribution, `mcpTools`, was removed in v0.12. After that the host's `start`
and `stop` were empty, but everything around it stayed:

- `main/index.ts` built a services object for it — event query and search,
  event append, bookmarks, config, and outbound `fetch` — and passed it to a
  host that never called any of them;
- `methodAllowed`, the capability check, was called only by a test;
- `resources/plugin-runner.js`, the child script, shipped in every packaged
  build and was never forked;
- a plugin contributing `exporters` or `monitors` was classified privileged,
  asked the operator to grant it trust, and then executed nothing.

And the documentation kept describing it. The README told users privileged
plugins "run in an isolated utility process"; the plugin development guide told
authors their code runs "in an isolated Electron utility process, never in the
main process", and documented a `ctx` API. Neither is true: the one privileged
contribution that does run, `tailers`, is loaded into the main process.

## Correction to the audit that proposed this

The audit listed the capability grant mechanism as part of the unused tier.
It is not. `tailers` is privileged and has a live path; the trust gate —
content-hash pinning and operator consent — is its only guard, and stays.

## User Scenarios & Testing

### User Story 1 - The documentation describes what RedLog actually does (Priority: P1)

As an operator or plugin author, I need the README and the plugin guide to say
truthfully where plugin code runs, because I decide what to install on the
strength of it.

**Independent Test**: No user-facing document claims privileged plugin code
runs isolated, or documents a `ctx` API.

### User Story 2 - A plugin that cannot run is refused, not silently inert (Priority: P1)

As a plugin author, if my plugin contributes something RedLog cannot run, I
need an error saying so, not a plugin that loads, asks for trust and does
nothing.

**Independent Test**: A manifest contributing `exporters` or `monitors` is
rejected with a message naming the key.

### User Story 3 - The trust gate still guards the code that runs (Priority: P1)

As an operator, I need a bundled tailer to stay inert until I grant trust.

**Independent Test**: A plugin contributing `tailers` is privileged, starts as
needs-consent, and its trust is pinned to its content hash.

### Edge Cases

- A manifest one API version ahead that contributes `tailers` is still refused
  its newer code.
- A capture hook remains part of the content hash.
- The plugin `kind` value `exporter` (the Source/Processor/Exporter taxonomy)
  is unrelated to the retired contribution and is unaffected.

## Requirements

- **FR-001**: The code host, its services object, the capability check and the
  child script MUST be removed, and the child script MUST NOT be packaged.
- **FR-002**: `exporters` and `monitors` MUST be rejected by manifest
  validation with a message naming the key.
- **FR-003**: `tailers` MUST remain privileged and trust-gated.
- **FR-004**: User-facing documentation MUST NOT claim privileged plugin code
  runs isolated, and MUST NOT document the removed `ctx` API.
- **FR-005**: `searchEvents`, whose last caller was the host's services object,
  MUST be removed, and its assertions MUST run unchanged against the query
  contract.

## Success Criteria

- **SC-001**: No source path constructs a plugin host.
- **SC-002**: Packaged builds contain no `plugin-runner.js`.
- **SC-003**: Every trust-gate test passes against a `tailers` fixture.

## Assumptions

- Pre-release (Spec 006): third-party manifests using the retired keys are
  refused without a migration path.
