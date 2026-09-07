#!/usr/bin/env node
// pcap-capture reader — spawns tcpdump in TEXT mode, folds packets into flows,
// and POSTs each flow summary to RedLog's local API as a scanner event. Runs
// OUT OF PROCESS (like every other RedLog producer): no capture code runs
// inside RedLog, and this needs root / CAP_NET_RAW, which RedLog itself must
// not hold. The pure parsing/classification lives in pcap-parse.js and is
// unit-tested; this file is the I/O shell around it.
//
//   Usage: pcap-capture.js <interface> [bpf filter…]
//   e.g.:  sudo pcap-capture.js eth0 'not (host 127.0.0.1 and port <API_PORT>)'
//
// Honest-capture contract: if RedLog is closed (no api-port/token), we capture
// nothing — a flow with nowhere to land is not evidence. Attribution is added
// by RedLog's ingest (local_port → pid → command); this side just carries the
// source port.

const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { parseTcpdumpLine, parseTsharkLine, FlowAggregator } = require('./pcap-parse.js')

const FLUSH_MS = 3000
const portFile = path.join(os.homedir(), '.redlog', 'api-port')
const tokenFile = path.join(os.homedir(), '.redlog', 'api-token')

function conn() {
  try {
    if (!fs.existsSync(portFile) || !fs.existsSync(tokenFile)) return null
    return {
      port: fs.readFileSync(portFile, 'utf8').trim(),
      token: fs.readFileSync(tokenFile, 'utf8').trim()
    }
  } catch { return null }
}

async function post(data) {
  const c = conn()
  if (!c) return false // RedLog closed → drop; nowhere to attribute it.
  try {
    const r = await fetch(`http://127.0.0.1:${c.port}/api/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'scanner', timestamp: Date.now(), data })
    })
    return r.ok
  } catch { return false }
}

// --tshark selects the Windows/npcap capture path (Wireshark's CLI) with a
// field parser; the default is tcpdump. Both feed the same aggregator.
const useTshark = process.argv.includes('--tshark')
const iface = process.argv.filter((a) => a !== '--tshark')[2]
if (!iface) {
  process.stderr.write('usage: pcap-capture.js [--tshark] <interface> [bpf filter]\n')
  process.exit(2)
}
const filter = process.argv.filter((a) => a !== '--tshark').slice(3)

const [cmd, args, parseLine] = useTshark
  ? [
      'tshark',
      // Field mode: fixed column order matching parseTsharkLine.
      ['-i', iface, '-l', '-n', '-T', 'fields', '-E', 'separator=/t',
        '-e', 'ip.src', '-e', 'tcp.srcport', '-e', 'ip.dst', '-e', 'tcp.dstport',
        '-e', 'frame.protocols', '-e', 'tcp.flags', '-e', 'frame.len',
        '-e', 'ipv6.src', '-e', 'udp.srcport', '-e', 'ipv6.dst', '-e', 'udp.dstport',
        ...(filter.length ? ['-f', filter.join(' ')] : [])],
      parseTsharkLine
    ]
  : [
      'tcpdump',
      // -nn no name/port resolution, -tttt absolute human ts, -l line-buffered.
      ['-nn', '-tttt', '-l', '-q', '-i', iface, ...filter],
      parseTcpdumpLine
    ]
const td = spawn(cmd, args)

const agg = new FlowAggregator()
let carry = ''
let posted = 0

td.stdout.on('data', (buf) => {
  const lines = (carry + buf.toString('utf8')).split('\n')
  carry = lines.pop() || ''
  for (const line of lines) agg.add(parseLine(line))
})

td.stderr.on('data', (b) => process.stderr.write(`[${cmd}] ${b}`))
td.on('exit', (code) => {
  process.stderr.write(`\n[redlog pcap-capture] ${cmd} exited (${code})\n`)
  flush().finally(() => process.exit(code ?? 0))
})

async function flush() {
  const flows = agg.flush()
  for (const f of flows) {
    if (await post(f)) posted++
  }
  if (flows.length) process.stderr.write(`[redlog pcap-capture] posted ${flows.length} flow(s) (${posted} total)\r`)
}

const timer = setInterval(flush, FLUSH_MS)
process.on('SIGINT', () => { clearInterval(timer); td.kill('SIGINT') })
process.on('SIGTERM', () => { clearInterval(timer); td.kill('SIGTERM') })
