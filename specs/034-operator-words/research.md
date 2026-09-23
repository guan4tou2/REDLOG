# Research: Settings Search, Type Names, Clock Meaning

- **Why generated keys, not a hand list**: a hand list drifts silently; a
  generated list with a test that compares it to the source cannot.
- **Why not a runtime DOM crawl of all pages**: pages render only when open,
  and some fetch data first; the i18n keys are static and complete.
- **Clock**: `StatusBar.tsx` documents audit P1 #33 — the counter is
  engagement-scoped by decision. The operator-feedback item offered "session
  start, or say project-creation"; the second keeps that decision.
