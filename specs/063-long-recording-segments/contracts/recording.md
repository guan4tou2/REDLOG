# Recording and export contract

- append(frame) returns true only after all of that frame is committed; capacity rotates, disk failure returns false. Terminal forwarding is independent of preview.
- close() is idempotent, closes the current descriptor and reports all committed parts. No writes after close.
- readCastRange(root, off, len) crosses physical parts using logical offsets. readCastSlice(root, start, end) keeps source-relative timestamps. Missing/corrupt parts are failure, reader budget is truncated=true.
- Replay callers propagate truncated. Export uses all physical evidence, not replay output.
- queryCommandOutput(command, negative limit) has no preview cap; export applies its own canonical snapshot after companion expansion.
- Selection/exclusion never edits source .cast/body files. Individual parts remain visible in attachment approval.
