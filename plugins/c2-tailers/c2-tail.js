#!/usr/bin/env node
// c2-tail — follow a C2 framework log and POST each parsed line to RedLog
// (SPEC-AI-ERA-PLUGINS Gap 2). A shell-side continuous poster (🟢, out-of-process),
// not an in-RedLog TailerAdapter: the built-in tailer system is transcript-shaped
// (ParsedTurn/cwd) and trust-gated, whereas a C2 log is a raw event stream that
// should emit scanner/pivot events — so the faithful, safer vehicle is a
// standalone follower that talks to the authenticated local API, like scan-parsers.
//
//   node c2-tail.js <framework> <logfile>
//     framework = generic | sliver     (see parse.js for the shapes)
//
// Follows appends (poll every 1s), survives truncation/rotation (re-reads from 0
// when the file shrinks), and records only while RedLog is open.
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { parseC2Line } = require('./parse.js')

const framework = process.argv[2] || 'generic'
const logFile = process.argv[3]
if (!logFile) {
  process.stderr.write('usage: c2-tail.js <generic|sliver> <logfile>\n')
  process.exit(2)
}

const portFile = path.join(os.homedir(), '.redlog', 'api-port')
const tokenFile = path.join(os.homedir(), '.redlog', 'api-token')

function redlogConn() {
  try {
    if (!fs.existsSync(portFile) || !fs.existsSync(tokenFile)) return null
    return { port: fs.readFileSync(portFile, 'utf8').trim(), token: fs.readFileSync(tokenFile, 'utf8').trim() }
  } catch { return null }
}

async function post(ev) {
  const conn = redlogConn()
  if (!conn) return false   // RedLog closed → capture nothing
  try {
    const r = await fetch(`http://127.0.0.1:${conn.port}/api/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${conn.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(ev)
    })
    return r.ok
  } catch { return false }
}

let offset = 0
let carry = ''
let posted = 0

async function drain() {
  let stat
  try { stat = fs.statSync(logFile) } catch { return }   // not created yet
  if (stat.size < offset) { offset = 0; carry = '' }      // truncated / rotated → restart
  if (stat.size === offset) return
  let chunk = ''
  try {
    const fd = fs.openSync(logFile, 'r')
    const buf = Buffer.alloc(stat.size - offset)
    fs.readSync(fd, buf, 0, buf.length, offset)
    fs.closeSync(fd)
    chunk = buf.toString('utf8')
  } catch { return }
  offset = stat.size
  const lines = (carry + chunk).split('\n')
  carry = lines.pop() || ''   // last partial line waits for the rest
  for (const line of lines) {
    const ev = parseC2Line(line, framework)
    if (ev && await post(ev)) {
      posted++
      process.stderr.write(`[redlog c2-tailers] posted ${framework} event (${posted} total)\r`)
    }
  }
}

process.stderr.write(`[redlog c2-tailers] following ${logFile} (${framework})\n`)
setInterval(() => { void drain() }, 1000)
void drain()
