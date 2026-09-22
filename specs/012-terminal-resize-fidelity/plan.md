# Implementation Plan: Terminal Resize Fidelity

## Constitution Check

- Evidence Integrity: geometry changes become part of the immutable cast bytes.
- Explicit Failure: a cast write failure cannot break the live terminal action.
- Risk-Based Verification: begin with a real-PTY journey that currently fails.
- Architectural Restraint: extend the existing cast writer without a new service.

## Design

1. Store current terminal geometry in the live session.
2. After a successful PTY resize, validate and skip unchanged dimensions.
3. Append an asciicast v2 resize frame through the recording byte-limit policy.
4. Verify the persisted frame in the existing command-I/O Electron journey.
