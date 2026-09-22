# Research: HTTP Body Search

The evidence database FTS indexes event JSON. Externalized bodies are replaced
by SHA references, so it cannot index their content. Copying body text into the
evidence database would undermine retention and bundle boundaries. A separate,
rebuildable FTS cache keeps source evidence immutable and can be deleted or
rebuilt independently.
