#!/usr/bin/env node
// Which sources make up each renderer chunk — PERF-AUDIT-2026-11 §5.
//
//   npx electron-vite build --sourcemap --outDir <dir>
//   node docs/perf-audit-2026-11/bundle-attribution.mjs <dir>/renderer/assets [--top N]
//
// Walks every mapping in each chunk's source map and charges the generated
// bytes between one mapping and the next to the mapping's source. Bytes with
// no mapping (Rollup's glue) are "(unmapped)". Sources are grouped by npm
// package, or by src/ directory for our own code.

import fs from 'node:fs'
import path from 'node:path'
import { SourceMapConsumer } from 'source-map-js'

const dir = process.argv[2]
const top = Number(process.argv[process.argv.indexOf('--top') + 1] || 12)
if (!dir) { console.error('usage: bundle-attribution.mjs <renderer/assets dir>'); process.exit(2) }

function group(src) {
  const s = src.replace(/\\/g, '/')
  const nm = s.lastIndexOf('node_modules/')
  if (nm !== -1) {
    const rest = s.slice(nm + 'node_modules/'.length).split('/')
    return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]
  }
  const m = s.match(/src\/(renderer\/src\/[^/]+(?:\/[^/]+)?|core\/[^/]+(?:\/[^/]+)?|[^/]+\/[^/]+)/)
  if (m) return m[1].replace(/\.(tsx?|json)$/, '')
  return s
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'))
const grand = new Map()
for (const f of files.sort()) {
  const code = fs.readFileSync(path.join(dir, f), 'utf8')
  const mapFile = path.join(dir, `${f}.map`)
  if (!fs.existsSync(mapFile)) continue
  const smc = new SourceMapConsumer(JSON.parse(fs.readFileSync(mapFile, 'utf8')))
  const lines = code.split('\n')
  const lineStart = []
  let off = 0
  for (const l of lines) { lineStart.push(off); off += Buffer.byteLength(l, 'utf8') + 1 }
  const maps = []
  smc.eachMapping((m) => maps.push(m), null, SourceMapConsumer.GENERATED_ORDER)
  const bytes = new Map()
  let mapped = 0
  for (let i = 0; i < maps.length; i++) {
    const m = maps[i]
    const n = maps[i + 1]
    const line = lines[m.generatedLine - 1] ?? ''
    const endCol = n && n.generatedLine === m.generatedLine ? n.generatedColumn : line.length
    const len = Buffer.byteLength(line.slice(m.generatedColumn, endCol), 'utf8')
    const key = m.source ? group(m.source) : '(unmapped)'
    bytes.set(key, (bytes.get(key) ?? 0) + len)
    mapped += len
  }
  const total = Buffer.byteLength(code, 'utf8')
  bytes.set('(unmapped)', (bytes.get('(unmapped)') ?? 0) + Math.max(0, total - mapped))
  console.log(`\n${f}  ${(total / 1024).toFixed(1)} KiB`)
  for (const [k, v] of [...bytes].sort((a, b) => b[1] - a[1]).slice(0, top)) {
    console.log(`  ${(v / 1024).toFixed(1).padStart(8)} KiB ${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`)
    grand.set(k, (grand.get(k) ?? 0) + v)
  }
}
console.log('\nAll chunks, top groups:')
for (const [k, v] of [...grand].sort((a, b) => b[1] - a[1]).slice(0, top * 2)) console.log(`  ${(v / 1024).toFixed(1).padStart(8)} KiB  ${k}`)
