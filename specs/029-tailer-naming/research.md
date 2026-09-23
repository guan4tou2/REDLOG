# Research: Tailer Naming

- **Decision**: rename the PowerShell follower; keep `agentTailer`.
- **Why not also rename `agentTailer`**: the ambiguity was one-sided. Renaming
  it would also rename the capture-health source id and its `configPath`, which
  the readiness checklist and its tests key on — churn with nothing clarified.
- **Why not run the PowerShell follower on the tailer host** (the audit's
  suggestion): checked, and it does not fit. The host appends each agent turn
  to a hash-chained sidecar, resolves `_causes` across turns, and emits
  `agent.*` events. The PowerShell follower re-parses a whole
  Start-Transcript file on each change and emits `shell` command events,
  deliberately without byte offsets (see its header). Sharing chokidar is all
  they would have in common.
