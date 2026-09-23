# Quickstart: Every Search on the Query Contract

1. Open ⌘K and type `session:<an agent session id>`; confirm that session's events.
2. Type `session:` and confirm the palette says the condition is incomplete.
3. `curl -H "Authorization: Bearer <token>" "http://127.0.0.1:<port>/api/events/search?q=session:"`
   and confirm a 400 with `reason: empty-condition-value`.
