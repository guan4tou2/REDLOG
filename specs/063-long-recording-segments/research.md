# Decisions

- Use individually playable .cast parts with the original timestamp/frame clock. Reason: retains external replay tooling and existing file approval. Rejected: an unbounded single file, raising the cap, or a second duplicate full recording.
- Stable first-part reference and logical offsets. Reason: command spans crossing a boundary stay exact without rewriting chained events. Reader owns part ordering; missing intermediate parts fail explicitly.
- Separate reader and storage budgets. Reason: a large session must not exhaust the renderer or lose evidence when its preview is bounded.
- Export all persisted companions at the canonical snapshot. Existing query gathered all rows then sliced at 2,000; increasing that constant is not completeness.
- No external research/dependency required: decisions follow the repository's existing source paths and evidence contracts.
