# Research: Transcript Completeness

## Decision: cursor per event-type bucket

One global cap lets high-volume scanner rows crowd out agent and shell evidence.
Each balanced bucket therefore keeps an independent canonical cursor. A Load
Older action advances every bucket that still has more evidence.

## Decision: rebuild projection after merge

Command and tool pairs can cross a page boundary. Rebuilding blocks from the
deduplicated loaded-event set allows an incomplete pair to become complete when
its older counterpart arrives.
