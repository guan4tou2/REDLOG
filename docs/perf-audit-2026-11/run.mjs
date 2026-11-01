#!/usr/bin/env node
// Runner for the PERF-AUDIT-2026-11 benches.
//
//   node docs/perf-audit-2026-11/run.mjs <bench.ts> [--prof] [--heap] [-- bench args]
//
// Bundles a bench entry with esbuild (the same toolchain Vite uses, already in
// node_modules), then runs it under plain Node in a throwaway HOME so nothing
// touches the operator's real ~/.redlog. `--prof` adds `--cpu-prof` and writes
// the .cpuprofile next to the bench output (`--heap` does the same with
// `--heap-prof`); summarise it with
// `profile-summary.mjs`.
//
// The bundle keeps names and a source map, so the profile names real
// functions and profile-summary.mjs can attribute them to src/ files.

import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')

const argv = process.argv.slice(2)
const sep = argv.indexOf('--')
const own = sep === -1 ? argv : argv.slice(0, sep)
const passThrough = sep === -1 ? [] : argv.slice(sep + 1)
const entry = own.find((a) => !a.startsWith('--'))
if (!entry) {
  console.error('usage: node run.mjs <bench.ts> [--prof] [--heap] [-- args]')
  process.exit(2)
}
const prof = own.includes('--prof')
const heap = own.includes('--heap')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-perf-'))
// PERF_HOME reuses a home an Electron launch already populated (seed-project.ts
// writes into the project the app created, signed with the app's operator key).
const home = process.env.PERF_HOME ?? path.join(work, 'home')
fs.mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true })
// Bundled into out/perf-audit/ (gitignored with the rest of out/), not the
// temp dir: core resolves shipped assets relative to its own file — e.g.
// plugins/official-agents.ts looks for ../optional-ai beside out/main.
fs.mkdirSync(path.join(repo, 'out', 'perf-audit'), { recursive: true })
const outfile = path.join(repo, 'out', 'perf-audit', path.basename(entry).replace(/\.ts$/, '.cjs'))

await build({
  entryPoints: [path.resolve(here, entry)],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile,
  sourcemap: 'linked',
  sourcesContent: false,
  keepNames: true,
  external: ['better-sqlite3', 'electron', 'node-pty'],
  define: { __APP_VERSION__: '"perf-audit"', __APP_BUILD__: '"perf-audit"' },
  logLevel: 'warning'
})

const outDir = process.env.PERF_OUT ?? path.join(work, 'out')
fs.mkdirSync(outDir, { recursive: true })
const nodeArgs = ['--expose-gc', '--enable-source-maps']
if (prof) nodeArgs.push('--cpu-prof', `--cpu-prof-dir=${outDir}`, '--cpu-prof-interval=200')
if (heap) nodeArgs.push('--heap-prof', `--heap-prof-dir=${outDir}`)
const r = spawnSync(process.execPath, [...nodeArgs, outfile, ...passThrough], {
  stdio: 'inherit',
  cwd: repo,
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    NODE_PATH: path.join(repo, 'node_modules'),
    PERF_WORK: work,
    PERF_OUT: outDir,
    PERF_BUNDLE: outfile
  }
})
console.error(`[run] work dir ${work}`)
if (prof) console.error(`[run] cpu profile(s) in ${outDir}`)
process.exit(r.status ?? 1)
