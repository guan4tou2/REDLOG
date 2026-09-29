#!/usr/bin/env node
// Where the app hand-rolls a control instead of using the system's.
//
// Every layout complaint so far had the same cause: a button styled where it
// was used rather than carrying the geometry from components/Button.tsx. This
// prints who does it, worst first, so the next thing to fix is a fact rather
// than whichever screen someone happened to open.
//
// A report, not a gate. It fails nothing; the rules that have stabilised move
// into test/ as they do (docs/UIUX-CONTROLS-AND-COPY.md §6).
//
//   node scripts/audit-ui.mjs          all findings, grouped by file
//   node scripts/audit-ui.mjs --rule=button

import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const SRC = path.join(ROOT, 'src', 'renderer', 'src')

/** Files that own the system itself, so they must write the raw styles. */
const OWNS_THE_SYSTEM = new Set([
  'components/Button.tsx',
  'components/IconButton.tsx'
])

const RULES = [
  {
    id: 'button',
    what: 'a hand-rolled button: its own padding and radius instead of <Button>',
    // A <button> that styles a box for itself. Icon-only hit targets are
    // IconButton's job and are matched separately.
    test: (tag, attrs) => tag === 'button'
      && /className=/.test(attrs)
      && /\bpx-\d|\bpy-\d|\bp-\d\b/.test(attrs)
      && /rounded/.test(attrs)
  },
  {
    id: 'bare-button',
    what: 'a clickable element with no box at all — no edge, no hit area (§3.5)',
    test: (tag, attrs) => tag === 'button'
      && /className=/.test(attrs)
      && !/\bp[xy]?-\d|\bp-\d\b/.test(attrs)
      && !/\bh-\[|\bh-\d/.test(attrs)
      && !/rounded/.test(attrs)
  },
  {
    id: 'input',
    what: 'an input that sets its own height or focus ring instead of the standard 34px box',
    test: (tag, attrs) => (tag === 'input' || tag === 'textarea')
      && /className=/.test(attrs)
      && (/focus:ring-\d/.test(attrs) || /\bpy-\d/.test(attrs))
      && !/type="(checkbox|radio)"/.test(attrs)
  },
  {
    id: 'uppercase-heading',
    what: 'uppercase as the hierarchy signal — it does nothing to Chinese',
    test: (_tag, attrs) => /\buppercase\b/.test(attrs) && /text-redlog-text-(faint|dim)/.test(attrs)
  }
]

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.name.endsWith('.tsx')) yield full
  }
}

const only = process.argv.find((a) => a.startsWith('--rule='))?.split('=')[1]
const findings = new Map()   // file -> rule id -> count

for (const file of walk(SRC)) {
  const rel = path.relative(SRC, file).split(path.sep).join('/')
  if (OWNS_THE_SYSTEM.has(rel)) continue
  const text = fs.readFileSync(file, 'utf-8')
  for (const m of text.matchAll(/<(\w+)\b((?:[^<>]|\{[^{}]*\})*?)\/?>/gs)) {
    const [, tag, attrs] = m
    for (const rule of RULES) {
      if (only && rule.id !== only) continue
      if (!rule.test(tag, attrs)) continue
      const byRule = findings.get(rel) ?? new Map()
      byRule.set(rule.id, (byRule.get(rule.id) ?? 0) + 1)
      findings.set(rel, byRule)
    }
  }
}

const totals = new Map()
for (const byRule of findings.values()) {
  for (const [id, n] of byRule) totals.set(id, (totals.get(id) ?? 0) + n)
}

const ranked = [...findings.entries()]
  .map(([file, byRule]) => [file, byRule, [...byRule.values()].reduce((a, b) => a + b, 0)])
  .sort((a, b) => b[2] - a[2])

console.log('UI audit — docs/UIUX-CONTROLS-AND-COPY.md\n')
for (const rule of RULES) {
  if (only && rule.id !== only) continue
  console.log(`  ${String(totals.get(rule.id) ?? 0).padStart(4)}  ${rule.id}  — ${rule.what}`)
}
console.log(`\n  ${ranked.length} files, worst first:\n`)
for (const [file, byRule, total] of ranked.slice(0, 25)) {
  const detail = [...byRule].map(([id, n]) => `${id}×${n}`).join('  ')
  console.log(`  ${String(total).padStart(3)}  ${file.padEnd(46)} ${detail}`)
}
if (ranked.length > 25) console.log(`  … and ${ranked.length - 25} more`)
