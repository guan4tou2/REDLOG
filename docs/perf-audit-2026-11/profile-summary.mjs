#!/usr/bin/env node
// Summarise a V8 .cpuprofile: self time by function and by source file, and
// inclusive (total) time for the functions you name.
//
//   node docs/perf-audit-2026-11/profile-summary.mjs <file.cpuprofile> [--top N] [--total fnA,fnB,...] [--map bundle.cjs.map]
//
// With --map (the bench bundle's source map, written by run.mjs) each frame is
// attributed to its original src/ file rather than to the bundle.

import fs from 'node:fs'
import path from 'node:path'
import { SourceMapConsumer } from 'source-map-js'

const args = process.argv.slice(2)
const file = args[0]
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1] }
const top = Number(opt('--top', 25))
const totals = (opt('--total', '') || '').split(',').filter(Boolean)
const mapPath = opt('--map', null)

const prof = JSON.parse(fs.readFileSync(file, 'utf8'))
const smc = mapPath ? new SourceMapConsumer(JSON.parse(fs.readFileSync(mapPath, 'utf8'))) : null

const byId = new Map(prof.nodes.map((n) => [n.id, n]))
const parent = new Map()
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id)

// Sample counts → self time per node.
const dt = new Map()
for (let i = 0; i < prof.samples.length; i++) {
  const id = prof.samples[i]
  dt.set(id, (dt.get(id) ?? 0) + (prof.timeDeltas[i] ?? 0))
}
const totalUs = [...dt.values()].reduce((a, b) => a + b, 0)

function where(cf) {
  if (smc && cf.url && cf.url.endsWith('.cjs') && cf.lineNumber >= 0) {
    const p = smc.originalPositionFor({ line: cf.lineNumber + 1, column: Math.max(0, cf.columnNumber) })
    if (p.source) return p.source.replace(/^(\.\.\/)+/, '').replace(/\\/g, '/')
  }
  if (!cf.url) return '(native/vm)'
  if (cf.url.startsWith('node:')) return cf.url
  return path.basename(cf.url)
}

const selfByFn = new Map()
const selfByFile = new Map()
for (const [id, us] of dt) {
  const cf = byId.get(id).callFrame
  const loc = where(cf)
  const key = `${cf.functionName || '(anonymous)'}  [${loc}]`
  selfByFn.set(key, (selfByFn.get(key) ?? 0) + us)
  const fileKey = /node_modules|^node:|native|\(/.test(loc) ? loc.split('/').slice(0, 3).join('/') : loc
  selfByFile.set(fileKey, (selfByFile.get(fileKey) ?? 0) + us)
}

const fmt = (us) => `${(us / 1000).toFixed(0).padStart(8)} ms ${((us / totalUs) * 100).toFixed(1).padStart(5)}%`
console.log(`profile ${path.basename(file)} — ${(totalUs / 1000).toFixed(0)} ms sampled`)
console.log('\n== self time by function ==')
for (const [k, us] of [...selfByFn].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${fmt(us)}  ${k}`)
console.log('\n== self time by file ==')
for (const [k, us] of [...selfByFile].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${fmt(us)}  ${k}`)

if (totals.length) {
  // Inclusive time: a sample counts once for a function if it appears anywhere
  // on the sample's stack (recursion counted once).
  console.log('\n== inclusive time ==')
  const inc = new Map(totals.map((t) => [t, 0]))
  for (const [id, us] of dt) {
    const seen = new Set()
    let cur = id
    while (cur !== undefined) {
      const name = byId.get(cur).callFrame.functionName
      if (inc.has(name) && !seen.has(name)) { inc.set(name, inc.get(name) + us); seen.add(name) }
      cur = parent.get(cur)
    }
  }
  for (const [k, us] of [...inc].sort((a, b) => b[1] - a[1])) console.log(`${fmt(us)}  ${k}`)
}

// --callers fn: the stacks (5 frames up) that spend time in `fn`.
const callersOf = opt('--callers', null)
if (callersOf) {
  console.log(`\n== stacks through ${callersOf} ==`)
  const stacks = new Map()
  for (const [id, us] of dt) {
    let cur = id
    const chain = []
    let hit = false
    while (cur !== undefined) {
      const cf = byId.get(cur).callFrame
      if (hit) chain.push(`${cf.functionName || '(anon)'}@${where(cf).split('/').pop()}`)
      if (!hit && cf.functionName === callersOf) hit = true
      if (chain.length >= 6) break
      cur = parent.get(cur)
    }
    if (!hit) continue
    const k = chain.join(' < ')
    stacks.set(k, (stacks.get(k) ?? 0) + us)
  }
  for (const [k, us] of [...stacks].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`${fmt(us)}  ${k}`)
}
