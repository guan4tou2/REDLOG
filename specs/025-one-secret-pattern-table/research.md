# Research: One Secret Pattern Table

- **Decision**: One table of shapes, two explicit coverage lists, behaviour
  unchanged; the flag pattern removed.
- **Rationale**: The operator chose consolidation without a coverage change.
  The drift was invisible because each list lived in its own file; side by
  side, the differences are a reviewable policy rather than an accident.
- **Near-duplicate shapes kept on purpose**: `jwt_three_segment` /
  `jwt_with_json_payload`, `private_key_block` / `private_key_header`, and
  `named_secret_assignment` / `named_secret_value` differ because the two
  consumers matched them differently. Merging any pair would change one
  consumer's behaviour.
- **Why the literals were moved by program**: a hand-transcribed regex that
  differs by one escape changes what is matched and would pass review. The
  golden corpus is the check that the move was exact.
- **Credential detection excluded**: `credential-detector.ts` recognises the
  structure of credential use, not token shapes, and has no list to merge.
- **`redaction.ts` excluded**: its defaults are an entropy threshold and empty
  operator-configured lists, not shapes.
