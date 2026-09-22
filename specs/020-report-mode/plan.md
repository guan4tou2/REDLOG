# Implementation Plan: Report Mode

Extend EventBus pause state with a reason, expose a three-state IPC contract,
and add one explicit header control. Preserve the boolean recording API for
existing callers and overlays.

