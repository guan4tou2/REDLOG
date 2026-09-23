# Research: Architecture Gate

- **Why not knip / ts-prune**: neither is installed; the check is ~120 lines on
  the TypeScript compiler already in devDependencies and runs in ~1.5 s.
- **Why names, not the type checker's references**: not tried — a
  language-service find-references call per export (several hundred) would
  build and query the whole program for each. Name counting is an
  over-approximation of use (it can only miss), which is the right failure
  direction for a gate, and runs in about a second.
- **First scanner pass was wrong**: a token scanner mis-split text after regex
  and template literals and reported live code (e.g. `parseCodexLine`) as dead.
  The AST walk fixed it; findings dropped from 147 to 65.
- **Found by the gate, beyond dead code**: three test-covered functions whose
  production caller had its own copy (PowerShell follow, Search folds, sync vs
  async verify) and the raw-store cross-project write.
