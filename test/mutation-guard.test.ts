// A write the operator started must say so when it does not land. `runMutation`
// (lib/mutation.ts) is the shape for that; an await inside try/catch, a
// `.catch(...)`, or a check of a returned `{ ok: false }` are the others. The
// global `unhandledrejection` toast (lib/unhandledRejection.ts) is only the
// net under whatever is left. This is a ratchet over what is left: the number
// of unguarded mutating preload calls may go down, never up.
//
// To lower it: guard a call (prefer `runMutation` with a specific message),
// then set UNGUARDED_BASELINE to the new count (set it to 0 to read the "now"
// figure and the list from the failure message). A new call that is
// deliberately unguarded (fire-and-forget, or optimistic UI with its own
// rollback) raises the baseline in the same change, with the reason in the PR.
//
// The heuristic, text-based and deliberately simple:
//   - A *mutating call* is `window.redlog.<area>.<verb>(` or
//     `window.redlog.<area>.<verb><Upper…>(` for a verb in VERBS (optional
//     chaining allowed), minus the reads in NOT_WRITES and minus
//     `ipcRenderer.send` methods, which have no reply to fail (sendOnly).
//   - Its *expression* is the call plus any `.then(…)/.catch(…)/.finally(…)`
//     chained onto it, found by balancing brackets.
//   - It is *guarded* when any of these holds:
//       a) `runMutation(` appears within RUN_MUTATION_LOOKBACK lines before it
//          (the call is inside the thunk);
//       b) its expression has a `.catch(` or a two-argument `.then(ok, fail)`;
//       c) it is awaited and a `try {` opens on its line or within the
//          TRY_LOOKBACK lines before it;
//       d) its result is assigned (`const x = await …`) and `x.ok` or `!x`
//          is tested within the next few lines.
// Blind spots, on purpose: calls through an alias (`const api =
// window.redlog.hooks`) or a method passed as a value are not seen at all; a
// call whose *caller* catches (a helper returning the promise) counts as
// unguarded; (a) and (c) are windows, so an unrelated `runMutation(` or
// `try {` nearby can make a call look guarded; brackets inside string or
// template literals can throw the expression walk off.
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'
import { repoRelative } from './helpers/repo-path'

const ROOT = path.join(__dirname, '..')

// Counted 2026-11-11 after converting the last two the heuristic finds
// (chain.anchorNow in lib/chainActions.ts, app.installUpdate in AboutPage).
const UNGUARDED_BASELINE = 0

const VERBS = [
  'create', 'update', 'delete', 'set', 'save', 'rename', 'add', 'remove', 'import', 'clear', 'toggle',
  'write', 'install', 'uninstall', 'kill', 'anchor', 'redact', 'purge', 'pin', 'unpin', 'dismiss',
  'restore', 'move', 'reset', 'revoke', 'archive'
]
/** Method names the verb pattern catches that only read. */
const NOT_WRITES = new Set(['updateStatus'])
const CALL = new RegExp(`window\\.redlog\\??\\.([A-Za-z]+)\\??\\.((?:${VERBS.join('|')})(?:[A-Z][A-Za-z]*)?)\\(`, 'g')
const PRELOAD = fs.readFileSync(path.join(ROOT, 'src/preload/index.ts'), 'utf8')
/** `ipcRenderer.send` has no reply, so there is nothing to catch: such a call
 *  is fire-and-forget by construction and is not counted. Recognised by its
 *  preload line, `method: (…) => ipcRenderer.send('area:…'`. */
function sendOnly(area: string, method: string): boolean {
  return new RegExp(`\\b${method}:\\s*\\([^)]*\\)\\s*=>\\s*ipcRenderer\\.send\\('${area}:`).test(PRELOAD)
}
const RUN_MUTATION_LOOKBACK = 4
const TRY_LOOKBACK = 25

/** The call starting at `from` (its `(` at `open`) plus chained handlers.
 *  Returns whether a `.catch(` or a two-argument `.then(` is on the chain. */
function chainHandlesRejection(src: string, open: number): boolean {
  let i = open
  for (let hops = 0; hops < 20; hops++) {
    // `i` is at a `(`: walk to its matching `)`, noting a top-level comma.
    let depth = 0, comma = false
    const start = i
    for (; i < src.length && i - start < 8000; i++) {
      const c = src[i]
      if (c === '(' || c === '{' || c === '[') depth++
      else if (c === ')' || c === '}' || c === ']') { depth--; if (depth === 0) break }
      else if (c === ',' && depth === 1) comma = true
    }
    const name = /\.(\w+)\s*$/.exec(src.slice(Math.max(0, start - 40), start))?.[1]
    if (hops > 0 && (name === 'catch' || (name === 'then' && comma))) return true
    const next = /^\s*\.\s*(then|catch|finally)\s*\(/.exec(src.slice(i + 1, i + 200))
    if (!next) return false
    i = i + 1 + next[0].length - 1
  }
  return false
}

function unguarded(): string[] {
  const out: string[] = []
  for (const file of glob.sync('src/renderer/src/**/*.{ts,tsx}', { cwd: ROOT, absolute: true })) {
    const rel = repoRelative(ROOT, file)
    const src = fs.readFileSync(file, 'utf8')
    const lines = src.split(/\r?\n/)
    for (const m of src.matchAll(CALL)) {
      const [, area, method] = m
      if (NOT_WRITES.has(method) || sendOnly(area, method)) continue
      const at = m.index ?? 0
      const lineNo = src.slice(0, at).split('\n').length - 1
      const head = src.slice(src.lastIndexOf('\n', at - 1) + 1, at)
      if (lines.slice(Math.max(0, lineNo - RUN_MUTATION_LOOKBACK), lineNo + 1).join('\n').includes('runMutation(')) continue
      if (chainHandlesRejection(src, at + m[0].length - 1)) continue
      const awaited = /\bawait\s+[^;]*$/.test(head)
      if (awaited && (/\btry\s*\{/.test(head) || lines.slice(Math.max(0, lineNo - TRY_LOOKBACK), lineNo).some((l) => /\btry\s*\{/.test(l)))) continue
      const assigned = /(?:const|let)\s+(\w+)\s*=\s*await\s+$/.exec(head)
      if (assigned) {
        const name = assigned[1]
        const next = lines.slice(lineNo + 1, lineNo + 6).join('\n')
        if (new RegExp(`\\b${name}\\??\\.ok\\b|!\\s*${name}\\b`).test(next)) continue
      }
      out.push(`${rel}:${lineNo + 1} ${area}.${method}`)
    }
  }
  return out
}

describe('unguarded mutating preload calls in the renderer', () => {
  it('do not grow past the recorded baseline', () => {
    const found = unguarded()
    expect(found.length, `unguarded mutating calls now ${found.length} (baseline ${UNGUARDED_BASELINE}):\n${found.join('\n')}`)
      .toBeLessThanOrEqual(UNGUARDED_BASELINE)
  })
})
