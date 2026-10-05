#!/usr/bin/env node
// Nothing in test/ or e2e/ may assert a string this branch deleted from a
// locale file. See scripts/i18n-assertions.mjs for why the other gates miss it.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { removedValues, assertionsOnRemovedValues } from './i18n-assertions.mjs'

const root = process.cwd()
const LOCALES = ['src/renderer/src/i18n/en.json', 'src/renderer/src/i18n/zh-TW.json']
const SUITES = ['test', 'e2e']
const EXTENSIONS = new Set(['.ts', '.tsx'])
// The one file that must contain a removed string: its job is to prove this
// gate catches one. Keeping it in the sweep would mean the gate fails forever
// after the first real catch, which is how a gate gets switched off.
const EXEMPT = new Set(['test/i18n-assertions.test.ts'])

// The comparison point is where this branch left main, so the gate answers
// "has this branch broken an assertion", not "has anyone ever". An unreachable
// origin/main — a shallow checkout, a clone with no remote — skips rather than
// fails: a gate that fails on a missing ref is one someone switches off.
function baseRef() {
  try {
    return execFileSync('git', ['merge-base', 'origin/main', 'HEAD'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { return null }
}

function readAt(ref, file) {
  try {
    return JSON.parse(execFileSync('git', ['show', `${ref}:${file}`],
      { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch { return null }
}

function sources() {
  const out = []
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (EXTENSIONS.has(path.extname(entry.name))) {
        const rel = path.relative(root, full).split(path.sep).join('/')
        if (!EXEMPT.has(rel)) out.push({ path: rel, text: fs.readFileSync(full, 'utf8') })
      }
    }
  }
  for (const suite of SUITES) visit(path.join(root, suite))
  return out
}

const base = baseRef()
if (base === null) {
  // Locally this is a clone without the ref, and skipping is right. In CI it
  // means the checkout is too shallow to reach the merge base, and a gate that
  // silently checks nothing is worse than no gate — it reports "passed".
  if (process.env.CI) {
    console.error(
      'i18n assertion gate cannot run: no merge base with origin/main.\n' +
      'The checkout is too shallow — fetch main before this step.'
    )
    process.exit(1)
  }
  console.log('i18n assertion gate skipped: origin/main is not reachable from here.')
  process.exit(0)
}

const removed = new Set()
for (const locale of LOCALES) {
  const before = readAt(base, locale)
  if (before === null) continue // the locale did not exist at the base
  const now = JSON.parse(fs.readFileSync(path.join(root, locale), 'utf8'))
  for (const value of removedValues(before, now)) removed.add(value)
}

const failures = assertionsOnRemovedValues(removed, sources())
if (failures.length) {
  console.error(failures.join('\n'))
  console.error(
    '\nThese assertions describe copy that no longer exists. Update them with the change that removed the string —\n' +
    'e2e finds them otherwise, six minutes in, and only when every gate before it was green.'
  )
  process.exit(1)
}
console.log(`i18n assertion gate passed: nothing in test/ or e2e/ asserts any of the ${removed.size} string(s) this branch removed.`)
