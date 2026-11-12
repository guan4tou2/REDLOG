#!/usr/bin/env node
// c2-tail — follow a C2 framework log and POST each parsed line to RedLog
// (SPEC-AI-ERA-PLUGINS Gap 2). A shell-side continuous poster (🟢, out-of-process),
// not an in-RedLog TailerAdapter: the built-in tailer system is transcript-shaped
// (ParsedTurn/cwd) and trust-gated, whereas a C2 log is a raw event stream that
// should emit scanner/pivot events — so the faithful, safer vehicle is a
// standalone follower that talks to the authenticated local API, like scan-parsers.
//
//   node c2-tail.js [--from-start] <framework> <logfile>
//     framework = generic | sliver     (see parse.js for the shapes)
//
// Starts at the end of an existing log (pass --from-start to import what is
// already there), follows appends (poll every 1s), and re-reads from 0 when
// the file is truncated or rotated. A line is consumed only once RedLog has
// taken it: while RedLog is closed or a post fails, the follower stays on that
// line and retries it next tick. The offset rules live in follow.js.
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { parseC2Line } = require('./parse.js')
const { initialOffset, resyncOffset, drainLines, postOutcome } = require('./follow.js')

const args = process.argv.slice(2)
const fromStart = args.includes('--from-start')
const positional = args.filter((a) => a !== '--from-start')
const framework = positional[0] || 'generic'
const logFile = positional[1]
if (!logFile) {
  process.stderr.write('usage: c2-tail.js [--from-start] <generic|sliver> <logfile>\n')
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
  if (!conn) return 'retry'   // RedLog closed → keep the line for later
  try {
    const r = await fetch(`http://127.0.0.1:${conn.port}/api/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${conn.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(ev)
    })
    const outcome = postOutcome(r.status)
    if (outcome === 'drop') process.stderr.write(`\n[redlog c2-tailers] RedLog refused a ${ev.agent_type} event (HTTP ${r.status}); skipped\n`)
    return outcome
  } catch { return 'retry' }
}

let offset = null      // set on the first stat; null until the file exists
let ino = null
let posted = 0
let running = false

function start() {
  let stat = null
  try { stat = fs.statSync(logFile) } catch { /* not created yet */ }
  offset = initialOffset(stat ? stat.size : null, fromStart)
  ino = stat ? stat.ino : null
}

async function drain() {
  if (running) return     // a slow post must not let two drains read the same lines
  running = true
  try {
    let stat
    try { stat = fs.statSync(logFile) } catch { return }   // not created yet
    offset = resyncOffset(offset, stat, ino)
    ino = stat.ino
    if (stat.size === offset) return
    let buf
    try {
      const fd = fs.openSync(logFile, 'r')
      try {
        buf = Buffer.alloc(stat.size - offset)
        fs.readSync(fd, buf, 0, buf.length, offset)
      } finally { fs.closeSync(fd) }
    } catch { return }
    const r = await drainLines(buf, offset, (line) => parseC2Line(line, framework), post)
    offset = r.offset
    if (r.posted > 0) {
      posted += r.posted
      process.stderr.write(`[redlog c2-tailers] posted ${framework} event (${posted} total)\r`)
    }
  } finally { running = false }
}

start()
process.stderr.write(`[redlog c2-tailers] following ${logFile} (${framework}) from ${offset === 0 ? 'the start' : `byte ${offset}`}\n`)
setInterval(() => { void drain() }, 1000)
void drain()
