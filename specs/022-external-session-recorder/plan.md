# Plan

Use a bundled Python standard-library POSIX PTY launcher, available through
both existing Bash/Zsh adapters. One bounded worker queue posts shell
session_output events to the canonical API. Use an engagement header checked
by the API before ingest; never re-read credentials during a running session.
Show output chunks as session output in Transcript and Timeline. Package the
helper alongside current adapters. Verify PTY behavior and identity refusal
with local integration tests, plus existing pause and desktop journeys.

Constitution: preserve source/provenance, disclose gaps, no new storage layer.
