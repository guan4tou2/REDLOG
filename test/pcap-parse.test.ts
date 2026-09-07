import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
// The parser ships in the pcap-capture producer pack (out-of-process, CommonJS).
// We import the very file the reader runs, so this test is the guard for the
// real code, not a copy of it.
const { parseTcpdumpLine, parseTsharkLine, tsharkFlagsToString, splitHostPort, FlowAggregator, classifyFlow } =
  require('../plugins/pcap-capture/pcap-parse.js')

describe('pcap-parse: tcpdump line → packet', () => {
  it('parses a TCP SYN line', () => {
    const p = parseTcpdumpLine(
      '2026-09-07 12:00:00.123456 IP 10.0.0.5.54321 > 10.0.0.9.443: Flags [S], seq 0, win 1024, length 0'
    )
    expect(p).toMatchObject({
      ipVersion: 4, proto: 'tcp', flags: 'S',
      srcHost: '10.0.0.5', srcPort: 54321, dstHost: '10.0.0.9', dstPort: 443, length: 0
    })
  })

  it('parses a UDP line and an IPv6 line', () => {
    const u = parseTcpdumpLine('2026-09-07 12:00:00.300000 IP 10.0.0.5.53000 > 8.8.8.8.53: UDP, length 40')
    expect(u).toMatchObject({ proto: 'udp', dstPort: 53, length: 40 })
    const v6 = parseTcpdumpLine('2026-09-07 12:00:00.200001 IP6 fe80::1.5353 > ff02::fb.5353: UDP, length 0')
    expect(v6).toMatchObject({ ipVersion: 6, proto: 'udp', srcHost: 'fe80::1', srcPort: 5353, dstHost: 'ff02::fb' })
  })

  it('returns null for non-packet chatter', () => {
    expect(parseTcpdumpLine('tcpdump: listening on eth0, link-type EN10MB')).toBeNull()
    expect(parseTcpdumpLine('')).toBeNull()
  })

  it('splitHostPort keeps IPv6 colons and takes the last dotted field as port', () => {
    expect(splitHostPort('10.0.0.9.443')).toEqual({ host: '10.0.0.9', port: 443 })
    expect(splitHostPort('fe80::1.5353')).toEqual({ host: 'fe80::1', port: 5353 })
  })
})

describe('pcap-parse: tshark field rows → packet (Windows/npcap path)', () => {
  // Columns: ip.src srcport ip.dst dstport frame.protocols tcp.flags frame.len [ipv6…]
  const tcp = (flags: string) =>
    ['10.0.0.5', '54321', '10.0.0.9', '443', 'eth:ethertype:ip:tcp', flags, '60', '', '', '', ''].join('\t')

  it('maps hex tcp.flags to the same S/./P string as tcpdump', () => {
    expect(tsharkFlagsToString('0x00000002')).toBe('S')     // SYN
    expect(tsharkFlagsToString('0x00000012')).toBe('S.')    // SYN-ACK
    expect(tsharkFlagsToString('0x00000010')).toBe('.')     // ACK
    expect(tsharkFlagsToString('0x00000004')).toBe('R')     // RST
  })

  it('parses a TCP SYN row', () => {
    const p = parseTsharkLine(tcp('0x00000002'))
    expect(p).toMatchObject({ proto: 'tcp', flags: 'S', srcHost: '10.0.0.5', srcPort: 54321, dstHost: '10.0.0.9', dstPort: 443, length: 60, ipVersion: 4 })
  })

  it('parses a UDP row (ports in the udp columns) and an IPv6 row', () => {
    const udp = ['', '', '', '', 'eth:ethertype:ip:udp', '', '40', '', '53000', '', '53']
    // udp needs ip.src/dst too; supply them in the ipv4 columns.
    udp[0] = '10.0.0.5'; udp[2] = '8.8.8.8'
    expect(parseTsharkLine(udp.join('\t'))).toMatchObject({ proto: 'udp', srcPort: 53000, dstPort: 53, length: 40 })
    const v6 = ['', '', '', '', 'eth:ethertype:ipv6:tcp', '0x00000002', '80', 'fe80::1', '5353', 'ff02::fb', '5353']
    expect(parseTsharkLine(v6.join('\t'))).toMatchObject({ ipVersion: 6, proto: 'tcp', srcHost: 'fe80::1', dstHost: 'ff02::fb' })
  })

  it('returns null for a row with no src/dst', () => {
    expect(parseTsharkLine('\t\t\t\t\t\t')).toBeNull()
    expect(parseTsharkLine('too\tfew')).toBeNull()
  })

  it('a tshark SYN scan classifies as syn_only, same as tcpdump', () => {
    const agg = new FlowAggregator()
    agg.add(parseTsharkLine(tcp('0x00000002')))                                 // SYN out
    agg.add(parseTsharkLine(['10.0.0.9', '443', '10.0.0.5', '54321', 'eth:ethertype:ip:tcp', '0x00000004', '40', '', '', '', ''].join('\t'))) // RST back
    const forward = agg.flush().find((f) => f.dst_port === 443 && f.src === '10.0.0.5')
    expect(forward.syn_only).toBe(true)
    expect(forward.local_port).toBe(54321)
  })
})

describe('pcap-parse: flow aggregation + SYN-scan classification', () => {
  const syn = (dstPort: number) =>
    `2026-09-07 12:00:00.000000 IP 10.0.0.5.54321 > 10.0.0.9.${dstPort}: Flags [S], seq 0, win 1024, length 0`

  it('folds many packets of one 5-tuple into a single flow', () => {
    const agg = new FlowAggregator()
    agg.add(parseTcpdumpLine(syn(443)))
    agg.add(parseTcpdumpLine('2026-09-07 12:00:00.100000 IP 10.0.0.9.443 > 10.0.0.5.54321: Flags [S.], seq 1, ack 1, length 0'))
    agg.add(parseTcpdumpLine('2026-09-07 12:00:00.200000 IP 10.0.0.5.54321 > 10.0.0.9.443: Flags [.], ack 1, length 0'))
    expect(agg.size()).toBe(2) // one flow each direction
    const flows = agg.flush()
    expect(agg.size()).toBe(0)
    const forward = flows.find((f) => f.dst_port === 443 && f.src === '10.0.0.5')
    expect(forward.packets).toBe(2) // SYN + ACK from the client
    expect(forward.handshake).toBe(true) // it saw a plain ACK → completed
    expect(forward.syn_only).toBe(false)
  })

  it('flags a half-open SYN scan the connection monitor cannot see', () => {
    const agg = new FlowAggregator()
    // nmap -sS: bare SYN out, RST back, never an ACK. 3 ports probed.
    for (const port of [22, 80, 443]) {
      agg.add(parseTcpdumpLine(syn(port)))
      agg.add(parseTcpdumpLine(`2026-09-07 12:00:00.050000 IP 10.0.0.9.${port} > 10.0.0.5.54321: Flags [R.], seq 0, ack 1, length 0`))
    }
    const flows = agg.flush().filter((f) => f.src === '10.0.0.5')
    expect(flows).toHaveLength(3)
    for (const f of flows) {
      expect(f.syn_only).toBe(true)
      expect(f.handshake).toBe(false)
      expect(f.note).toMatch(/half-open probe/)
      // Attribution: the local ephemeral source port is carried so ingest can
      // resolve it to the owning nmap command.
      expect(f.local_port).toBe(54321)
      expect(f.subtype).toBe('packet_flow')
    }
  })

  it('a UDP flow is never misclassified as a SYN scan', () => {
    const f = classifyFlow({
      proto: 'udp', ipVersion: 4, srcHost: '10.0.0.5', srcPort: 53000,
      dstHost: '8.8.8.8', dstPort: 53, packets: 1, bytes: 40,
      firstTs: 't', lastTs: 't', flagsSeen: new Set()
    })
    expect(f.syn_only).toBe(false)
    expect(f.handshake).toBe(false)
    expect(f.proto).toBe('udp')
  })
})
