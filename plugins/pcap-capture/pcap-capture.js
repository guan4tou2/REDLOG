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
const { pcapSegmentEvent } = require('./pcap-sidecar.js')

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

async function post(data, agentType = 'scanner') {
  const c = conn()
  if (!c) return false // RedLog closed → drop; nowhere to attribute it.
  try {
    const r = await fetch(`http://127.0.0.1:${c.port}/api/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType, timestamp: Date.now(), data })
    })
    return r.ok
  } catch { return false }
}

// E3: while capturing, tell RedLog we're RUNNING with a periodic heartbeat, so
// capture-health can flag a producer that the operator started but which has
// stopped feeding (a real problem) — as opposed to one that was never run.
const PRODUCER_ID = 'pcap-capture'
function heartbeat() {
  return post({ subtype: 'producer_heartbeat', producer: PRODUCER_ID }, 'system')
}

// --pcap-out <dir>: RAW mode. Instead of text summaries, tcpdump writes rotating
// binary .pcap segments to <dir> (the operator's disk); we hash each completed
// segment and POST an integrity record (path + sha256) so the chain proves what
// the raw file was. This is mutually exclusive with the summary/tshark path.
const pcapOutIdx = process.argv.indexOf('--pcap-out')
if (pcapOutIdx !== -1) {
  const outDir = process.argv[pcapOutIdx + 1]
  const rawIface = process.argv.filter((a, i) => a !== '--pcap-out' && i !== pcapOutIdx + 1)[2]
  if (!outDir || !rawIface) {
    process.stderr.write('usage: pcap-capture.js --pcap-out <dir> <interface>\n')
    process.exit(2)
  }
  try { fs.mkdirSync(outDir, { recursive: true }) } catch { /* exists */ }
  // -G 300 -W 12: 5-minute segments, keep the last 12 (an hour). strftime name
  // so segments sort and never collide.
  const td = spawn('tcpdump', ['-i', rawIface, '-w', path.join(outDir, 'redlog-%Y%m%d-%H%M%S.pcap'), '-G', '300', '-W', '12'])
  td.stderr.on('data', (b) => process.stderr.write(`[tcpdump] ${b}`))
  const recorded = new Set()
  heartbeat() // raw mode is running too
  const hbTimer = setInterval(heartbeat, 15000)
  // When tcpdump opens the NEXT segment, the previous one is complete → hash it.
  async function sweep() {
    let files
    try { files = fs.readdirSync(outDir).filter((f) => f.endsWith('.pcap')).sort() } catch { return }
    // All but the newest (still being written) are complete.
    for (const f of files.slice(0, -1)) {
      if (recorded.has(f)) continue
      recorded.add(f)
      const ev = pcapSegmentEvent(path.join(outDir, f))
      if (ev) await post(ev)
    }
  }
  const sweepTimer = setInterval(sweep, 5000)
  const finish = (sig) => {
    clearInterval(sweepTimer)
    clearInterval(hbTimer)
    td.kill(sig)
  }
  td.on('exit', async () => {
    clearInterval(sweepTimer)
    clearInterval(hbTimer)
    // Hash every segment on exit, including the last (now closed) one.
    try {
      for (const f of fs.readdirSync(outDir).filter((x) => x.endsWith('.pcap')).sort()) {
        if (recorded.has(f)) continue
        const ev = pcapSegmentEvent(path.join(outDir, f))
        if (ev) await post(ev)
      }
    } catch { /* dir gone */ }
    process.exit(0)
  })
  process.on('SIGINT', () => finish('SIGINT'))
  process.on('SIGTERM', () => finish('SIGTERM'))
  return
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
heartbeat() // announce running immediately, then every 15s
const hbTimer = setInterval(heartbeat, 15000)
const stop = (sig) => { clearInterval(timer); clearInterval(hbTimer); td.kill(sig) }
process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))
