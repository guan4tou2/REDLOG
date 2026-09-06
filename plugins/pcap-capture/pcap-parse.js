// Pure parsing + flow aggregation for the pcap-capture producer. No I/O, no
// privilege — split out from the reader so it is unit-testable (see
// test/pcap-parse.test.ts) without ever running tcpdump. CommonJS so the
// out-of-process node reader can `require` it directly.
//
// Input is tcpdump's TEXT output (`-nn -tttt -l`), NOT binary pcap — parsing
// libpcap in pure JS would need a native dependency, and the text form carries
// everything RedLog needs to make a SYN scan visible and attributable.
//
// The headline job: recognise the class of traffic connection-monitor CANNOT
// see — half-open probes (`nmap -sS`, masscan) that never complete a handshake,
// so never appear in the socket table. Those show up here as flows that only
// ever carry a bare SYN.

// A tcpdump line looks like:
//   2026-09-07 12:00:00.123456 IP 10.0.0.5.54321 > 10.0.0.9.443: Flags [S], seq 0, win 1024, length 0
//   2026-09-07 12:00:00.200001 IP6 fe80::1.5353 > ff02::fb.5353: ... (IPv6)
//   2026-09-07 12:00:00.300000 IP 10.0.0.5.54321 > 10.0.0.9.53: UDP, length 40
// The destination is delimited by ": " (colon-space) — NOT a bare colon, which
// an IPv6 address (fe80::1) is full of. tcpdump always prints "dst: <desc>".
const LINE_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+) (IP6?) (\S+?) > (\S+?): (.*)$/

// Split "10.0.0.9.443" → { host: '10.0.0.9', port: 443 } and
// "fe80::1.5353" → { host: 'fe80::1', port: 5353 }. The port is always the
// last dot-separated field; the host is everything before it.
function splitHostPort(s) {
  const i = s.lastIndexOf('.')
  if (i < 0) return { host: s, port: undefined }
  const portStr = s.slice(i + 1)
  const port = /^\d+$/.test(portStr) ? Number(portStr) : undefined
  return { host: port === undefined ? s : s.slice(0, i), port }
}

/** Parse one tcpdump text line into a normalised packet, or null if it is not
 *  a line we understand (tcpdump prints plenty of non-packet chatter). */
function parseTcpdumpLine(line) {
  const m = LINE_RE.exec(line.trim())
  if (!m) return null
  const [, ts, ipVer, srcRaw, dstRaw, rest] = m
  const src = splitHostPort(srcRaw)
  const dst = splitHostPort(dstRaw)
  // Protocol + TCP flags. `Flags [S]` = SYN only, `[S.]` = SYN-ACK, `[.]` =
  // ACK, `[P.]` = push, `[F.]`/`[R.]` = fin/reset. UDP lines carry "UDP".
  let proto = 'other'
  let flags = null
  const flagsM = /Flags \[([^\]]*)\]/.exec(rest)
  if (flagsM) { proto = 'tcp'; flags = flagsM[1] }
  else if (/\bUDP\b/.test(rest)) proto = 'udp'
  else if (/\bICMP6?\b/.test(rest)) proto = 'icmp'
  // length N (bytes of payload) — best-effort.
  const lenM = /length (\d+)/.exec(rest)
  const length = lenM ? Number(lenM[1]) : 0
  return {
    ts,
    ipVersion: ipVer === 'IP6' ? 6 : 4,
    proto,
    flags,
    srcHost: src.host,
    srcPort: src.port,
    dstHost: dst.host,
    dstPort: dst.port,
    length
  }
}

// A flow is keyed by the ordered 5-tuple (src → dst), so a scan of a /24 that
// touches 254 hosts is 254 flows, and a held-open reverse shell is one. The
// aggregator folds packets into flows and, on flush, classifies each.
class FlowAggregator {
  constructor() { this.flows = new Map() }

  key(p) {
    return `${p.proto}|${p.srcHost}:${p.srcPort ?? ''}>${p.dstHost}:${p.dstPort ?? ''}`
  }

  add(packet) {
    if (!packet) return
    const k = this.key(packet)
    let f = this.flows.get(k)
    if (!f) {
      f = {
        proto: packet.proto,
        ipVersion: packet.ipVersion,
        srcHost: packet.srcHost, srcPort: packet.srcPort,
        dstHost: packet.dstHost, dstPort: packet.dstPort,
        packets: 0, bytes: 0,
        firstTs: packet.ts, lastTs: packet.ts,
        flagsSeen: new Set()
      }
      this.flows.set(k, f)
    }
    f.packets += 1
    f.bytes += packet.length
    f.lastTs = packet.ts
    if (packet.flags) for (const ch of packet.flags) f.flagsSeen.add(ch)
    return f
  }

  /** Empty the aggregator, returning one classified summary per flow. */
  flush() {
    const out = []
    for (const f of this.flows.values()) out.push(classifyFlow(f))
    this.flows.clear()
    return out
  }

  size() { return this.flows.size }
}

/** Turn an accumulated flow into the event `data` a producer POSTs. The
 *  interesting bit is `synOnly` / `handshake`: a flow that only ever carried a
 *  bare SYN (and maybe a RST back) never became a connection — that is exactly
 *  the `nmap -sS` probe the socket-table monitor is blind to. `local_port` is
 *  the source port so socket-attribution can resolve it to the owning command
 *  (scans originate locally). */
function classifyFlow(f) {
  const flags = f.flagsSeen
  // A completed TCP handshake shows a plain ACK / push / data after the SYN.
  const handshake = f.proto === 'tcp' && (flags.has('.') || flags.has('P'))
  const synOnly = f.proto === 'tcp' && flags.has('S') && !handshake
  return {
    subtype: 'packet_flow',
    proto: f.proto,
    ip_version: f.ipVersion,
    src: f.srcHost,
    src_port: f.srcPort,
    dst: f.dstHost,
    dst_port: f.dstPort,
    // For socket-attribution (local_port → pid → command). Scans go out from a
    // local ephemeral source port, so the source port is the local one.
    local_port: f.srcPort,
    packets: f.packets,
    bytes: f.bytes,
    first_ts: f.firstTs,
    last_ts: f.lastTs,
    tcp_flags: [...flags].sort().join(''),
    handshake,
    // The whole reason pcap exists: half-open probes the socket table misses.
    syn_only: synOnly,
    // Honest label carried on the event itself, so a reader who filters to
    // syn_only sees why these have no matching `scanner.connection`.
    note: synOnly ? 'half-open probe (no handshake) — not visible to the connection monitor' : undefined
  }
}

module.exports = { parseTcpdumpLine, splitHostPort, FlowAggregator, classifyFlow }
