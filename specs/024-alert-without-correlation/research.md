# Research: Alerts Without Correlation

- **Decision**: Remove CombinedPolicy and BurstPolicy and the derived-policy
  path in the bus.
- **Rationale**: They are correlation, which the product boundary excludes; no
  surface but the chain uses their output; and their chain events cite no
  source, which Evidence Provenance requires of derived events.
- **Checked before deciding**: whether Burst protects the chain from floods.
  Its code comment calls it a rate limiter, but `ingest` only returns an
  additional verdict and does not suppress the scope verdicts it counts. The
  flood it describes, if any, is unaffected by its removal.
- **Alternative considered**: keep them and add `_causes`. Rejected: that
  repairs the provenance of a feature the product has declined, and still
  leaves nothing that presents them.
