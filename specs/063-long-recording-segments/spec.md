# Feature Specification: Long recording preservation

**Status**: Draft
**Date**: 2026-10-26
**Issue**: [#290](https://github.com/guan4tou2/REDLOG/issues/290)

## Scope and user scenarios

An operator keeps working in an external shell or a built-in PTY without choosing a recording mode for each command. Long output must not silently stop being stored at a per-file capacity threshold. After close, reopen, or interrupted recording, already committed evidence remains readable and exportable, in order and tied to its source.

1. A built-in recording crosses its file budget: all subsequent output is saved in bounded, independently playable parts. Commands crossing that boundary still read their exact output. Resize, pause, project switch and disk failure retain their current semantics.
2. Long shell/session output is persisted while the source runs. A bounded preview is distinct from evidence loss; interrupted transport, backpressure and paused bytes are disclosed. Interactive bytes do not imply independent execution of a command.
3. Exporting a command includes all its committed output companions at the approved snapshot, including more than 2,000 chunks. All cast parts have source/target attribution and individually approved bytes/hashes. Exclusion remains per attachment.
4. Existing issue #290 also covers HTTP/SSE/WebSocket. Inventory and fault injection must establish their actual limits; do not call the issue complete based only on PTY tests.

## Requirements

- FR-001: Recording capacity rotates files, preserving order, UTF-8 boundaries and original frame time. No append-only evidence is rewritten.
- FR-002: A logical recording reference and byte offsets stay valid across capacity boundaries; each part has its own hash and an aggregate recording hash covers ordered concatenated files.
- FR-003: A reader budget bounds preview memory and explicitly marks a subset; it never limits persisted/exported evidence.
- FR-004: Source/receive time, session/command identity, direction and chunk sequence remain distinguishable. Known omitted/paused bytes are disclosed; unknown totals stay unknown.
- FR-005: A frozen export resolves every companion within its dataset boundary. Later data must not leak into the approved artifact.
- FR-006: Pause, project isolation, terminal-App consent, no input/password capture, and safe refusal must not regress.
- FR-007: Disk/transport failure and abrupt source termination cannot be described as normal completion.

Canonical contracts: docs/domain/SPEC-export-event-selection.md; docs/domain/SPEC-capture-source-lifecycle.md. No new protocol parser, capture setting or UI mode is authorized.

## Clarification

No new product choice is required: user explicitly requested long output, segmentation and export under #290. Capacity is a file/preview budget, not a silent lifetime capture limit. Cross-platform execution is a separate acceptance result, not inferred from macOS fixtures.

## Acceptance

Long Unicode and control-character frames cross at least three parts; range and time reads recover their bytes. Export includes and hashes all parts, supports individual exclusion, rejects changed approved bytes, and includes >2,000 companions. Inject disk failure and source interruption. Run real bash/zsh PTY checks on Mac; Windows/WSL/Kali stay open until actually run there.
