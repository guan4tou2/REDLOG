# Quickstart: Architecture Gate

1. `npm run verify:architecture` → passes.
2. Export a new unused function from any `src/` file → the gate names it.
3. Delete an allowlisted function → the gate reports the stale entry.
