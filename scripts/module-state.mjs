// Module-state rule of the architecture gate (Spec 073 T002, FR-003/FR-090).
//
// What the rule looks at: statements at the top level of a file under
// src/core/** or src/main/** that create state which outlives a call:
//
//   let / var                              any initialiser
//   const = new X(...)                     Map, Set, WeakMap, BoundedMap, a class instance
//   const = [ ... ]                        an array literal
//   const = createSomething(...)           a factory call named create*
//
// Every one must be registered in scripts/module-state-allowlist.json with a
// class and a reason:
//
//   app             lives as long as the process; holds nothing about a project
//   machine         a property of this computer or its user, not of a project
//   constant        filled at declaration and never mutated afterwards
//   test-seam       exists so a test can replace or reset something
//   project-legacy  holds project-scoped state at module level today; Spec 073
//                   moves it into the per-project session. The count is a
//                   ratchet: it may go down, never up.
//
// A new unregistered declaration fails; so does an entry that matches nothing,
// an unknown class, a missing reason, and a project-legacy count that differs
// from the baseline (up is a new leak, down means lower the baseline).
//
// Blind spots, on purpose: object-literal consts, state held in a class's
// static fields, and a `let` inside a function or block are not module state
// and are not seen. A name shared by two declarations in one file is reported
// once, as a duplicate, since the key is file#name.

import ts from 'typescript'

export const MODULE_STATE_CLASSES = ['app', 'machine', 'constant', 'test-seam', 'project-legacy']

function unwrap(expr) {
  let e = expr
  while (e && (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e))) e = e.expression
  return e
}

/** Declarations of module state in one parsed source file. */
export function scanModuleState(sf) {
  const out = []
  for (const s of sf.statements) {
    if (!ts.isVariableStatement(s)) continue
    const isConst = (s.declarationList.flags & ts.NodeFlags.Const) !== 0
    for (const d of s.declarationList.declarations) {
      if (!ts.isIdentifier(d.name)) continue
      const init = d.initializer ? unwrap(d.initializer) : undefined
      let kind = null
      if (!isConst) kind = 'let/var'
      else if (init && ts.isNewExpression(init)) kind = 'new'
      else if (init && ts.isArrayLiteralExpression(init)) kind = 'array'
      else if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && /^create/.test(init.expression.text)) kind = 'create()'
      if (kind) out.push({ name: d.name.text, line: sf.getLineAndCharacterOfPosition(d.getStart()).line + 1, kind })
    }
  }
  return out
}

/**
 * @param found     [{ key: 'src/core/x.ts#name', line, kind }]
 * @param allowlist { projectLegacyBaseline: number, entries: { [key]: { class, reason } } }
 * @returns         problem strings (empty when the rule holds) and the project-legacy count
 */
export function checkModuleState(found, allowlist) {
  const problems = []
  const entries = allowlist?.entries ?? {}
  const seen = new Set()
  for (const f of found) {
    if (seen.has(f.key)) { problems.push(`${f.key}: declared twice in one file — the module-state key is file#name; rename one`); continue }
    seen.add(f.key)
    const e = entries[f.key]
    if (!e) {
      const [file, name] = f.key.split('#')
      problems.push(`${file}:${f.line} module-level ${f.kind} "${name}" is not in scripts/module-state-allowlist.json — project state belongs in the project session (Spec 073); if this is not project state, register it with a class and a reason`)
    }
  }
  let legacy = 0
  for (const [key, e] of Object.entries(entries)) {
    if (!seen.has(key)) { problems.push(`scripts/module-state-allowlist.json: "${key}" no longer matches a declaration — remove the entry`); continue }
    if (!MODULE_STATE_CLASSES.includes(e?.class)) problems.push(`scripts/module-state-allowlist.json: "${key}" has class ${JSON.stringify(e?.class)}; allowed: ${MODULE_STATE_CLASSES.join(', ')}`)
    if (typeof e?.reason !== 'string' || e.reason.trim().length < 8) problems.push(`scripts/module-state-allowlist.json: "${key}" needs a reason`)
    if (e?.class === 'project-legacy') legacy++
  }
  const baseline = allowlist?.projectLegacyBaseline
  if (!Number.isInteger(baseline)) problems.push('scripts/module-state-allowlist.json: projectLegacyBaseline must be an integer')
  else if (legacy > baseline) problems.push(`project-legacy module state is ${legacy}, baseline ${baseline} — a new module-level project binding; put it in the session instead (the ratchet only goes down)`)
  else if (legacy < baseline) problems.push(`project-legacy module state is ${legacy}, below baseline ${baseline} — lower projectLegacyBaseline to ${legacy} in the same change`)
  return { problems, projectLegacy: legacy }
}
