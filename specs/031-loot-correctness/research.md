# Research: Loot Detection Correctness

- **Why dedup at write time, not scan time**: the scan result is also the
  redaction denylist. Any filtering there removes masks.
- **Why the target is in the key**: the same credential working on a second
  host is a new finding; the Loot page can still group by value.
- **Why the private-key value includes a key line**: the header is identical
  for every key of an algorithm. The shape is used only by loot (transcript
  redaction uses `private_key_block`), so widening it changes no masking
  elsewhere. A key line of 16+ base64 characters is required for the body part;
  a bare header still matches.
- **Why no time bound on regex execution**: JavaScript cannot interrupt a
  running regex; a real bound needs worker isolation. Plugin rules are trusted
  declarative content today. The bound is required before operators can type
  rules into Settings, which is the next spec — not this one.
- **Checked**: bundled and example plugins — none uses a capture group, so the
  `group` default changes no shipped rule.
