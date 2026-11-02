#!/usr/bin/env node
// PERF-AUDIT-2026-11 §3.3 (b) and (c): what the OS charges for the file and
// hostname calls ingest makes per row.
//
//   node docs/perf-audit-2026-11/probe-fs.cjs
//
// write          writeFileSync of a 6 KB body
// reopenFirst    open+read+close of those files, after all were written
// reopenAgain    the same again (warm)
// writeThenOpen  write a file and open it immediately — what ingest does
//                (extractBodyToSidecar, then linkHttpBodyEvent's verify)
// hostnameUs     os.hostname(), called by both insert paths per row

const fs = require('fs')
const path = require('path')
const os = require('os')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-fsprobe-'))
const body = Buffer.alloc(6000, 97)
const N = 300
const ms = (t) => +((performance.now() - t) / N).toFixed(3)

let t = performance.now()
for (let i = 0; i < N; i++) fs.writeFileSync(path.join(dir, `f${i}`), body)
const write = ms(t)
t = performance.now()
for (let i = 0; i < N; i++) {
  const fd = fs.openSync(path.join(dir, `f${i}`), 'r')
  fs.readSync(fd, Buffer.alloc(6000), 0, 6000, 0)
  fs.closeSync(fd)
}
const reopenFirst = ms(t)
t = performance.now()
for (let i = 0; i < N; i++) fs.closeSync(fs.openSync(path.join(dir, `f${i}`), 'r'))
const reopenAgain = ms(t)
t = performance.now()
for (let i = 0; i < N; i++) {
  const p = path.join(dir, `g${i}`)
  fs.writeFileSync(p, body)
  fs.closeSync(fs.openSync(p, 'r'))
}
const writeThenOpen = ms(t)
t = performance.now()
for (let i = 0; i < N; i++) os.hostname()
const hostnameUs = +(((performance.now() - t) / N) * 1000).toFixed(1)

console.log(JSON.stringify({ perFileMs: { write, reopenFirst, reopenAgain, writeThenOpen }, hostnameUs }))
fs.rmSync(dir, { recursive: true, force: true })
