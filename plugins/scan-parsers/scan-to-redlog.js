#!/usr/bin/env node
// scan-to-redlog — a transparent filter for the scan-parsers pack
// (SPEC-AI-ERA-PLUGINS Gap 1). Reads a scanner's structured output on stdin,
// echoes it back on stdout unchanged (so it stays a drop-in pipe stage), and
// POSTs the parsed `scan_result` events to RedLog's local API. Records nothing
// when RedLog isn't running (no api-port/token) — same "only while open" rule
// as every other capture hook. Zero dependencies beyond Node's stdlib + parse.js.
//
//   nmap -oG -   <args> | node scan-to-redlog.js nmap
//   nuclei -jsonl <args> | node scan-to-redlog.js nuclei
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { parse } = require('./parse.js')

const tool = process.argv[2] || ''

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { input += c; process.stdout.write(c) })   // pass-through
process.stdin.on('end', async () => {
  let events = []
  try { events = parse(tool, input) } catch { events = [] }
  if (events.length === 0) return

  const portFile = path.join(os.homedir(), '.redlog', 'api-port')
  const tokenFile = path.join(os.homedir(), '.redlog', 'api-token')
  if (!fs.existsSync(portFile) || !fs.existsSync(tokenFile)) return   // RedLog not open — capture nothing
  let port, token
  try {
    port = fs.readFileSync(portFile, 'utf8').trim()
    token = fs.readFileSync(tokenFile, 'utf8').trim()
  } catch { return }

  let posted = 0
  for (const ev of events) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/events`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(ev)
      })
      if (r.ok) posted++
    } catch { /* RedLog closed mid-scan — drop silently */ }
  }
  process.stderr.write(`[redlog scan-parsers] posted ${posted}/${events.length} ${tool} scan_result event(s)\n`)
})
