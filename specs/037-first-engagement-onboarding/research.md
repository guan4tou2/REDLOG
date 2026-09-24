# Research: First-Engagement Onboarding

- **Validation source**: the Settings scope list accepted any string; rather
  than a second grammar, an entry is valid when `matchPattern` can match it
  against itself (CIDR contains its network address, `*.x` matches `x`), plus
  a hostname charset check because plain hosts compare as strings.
- **Why nonce, not "any shell event"**: a hook left over in another open
  terminal would otherwise count; the nonce proves the terminal the operator
  just opened is connected.
- **Why no new IPC**: the live batch stream already carries `agentType`,
  `data.subtype`, `data.source` and `data.command`.
- **Merge, not read-modify-write**: W3's post-create `config.get/save` could
  fail after the project existed and showed a misleading "open failed" toast;
  merging on create is atomic.
