// Raw-pcap sidecar (docs/DESIGN-traffic-attribution §3 "全抓 raw + sha256 on
// chain"). The flow-summary path keeps RedLog's structured view of traffic;
// this keeps the RAW packets for deep forensics — but RedLog holds no root and
// runs no capture, so the .pcap files live on the OPERATOR's capture host. What
// reaches RedLog is an integrity record per rotated segment: the file path and
// its sha256, which goes on the hash chain. The operator preserves the files;
// the chain proves what they were, so a later analyst can verify a .pcap
// against its recorded hash. CommonJS so the reader can require it.

const fs = require('fs')
const crypto = require('crypto')

/** Build the `scanner.pcap_segment` event for a completed .pcap file: its path,
 *  sha256 and byte size. Returns null if the file can't be read (mid-rotation,
 *  vanished) — a segment we can't hash is not recorded rather than recorded
 *  wrong. The sha256 is what lands on the chain; the bytes stay on the
 *  operator's disk at `pcap_file`. */
function pcapSegmentEvent(filePath) {
  let buf
  try { buf = fs.readFileSync(filePath) } catch { return null }
  if (buf.length === 0) return null
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
  return {
    subtype: 'pcap_segment',
    pcap_file: filePath,
    pcap_sha256: sha256,
    bytes: buf.length,
    // Honest: RedLog stores the hash, not the packets — the raw file is the
    // operator's to preserve. A reader who wants deep-packet forensics opens
    // pcap_file and can verify it against pcap_sha256.
    note: 'raw pcap kept on the capture host; only its sha256 is on the chain'
  }
}

module.exports = { pcapSegmentEvent }
