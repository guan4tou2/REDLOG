import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
const require = createRequire(import.meta.url)
const { pcapSegmentEvent } = require('../plugins/pcap-capture/pcap-sidecar.js')

// Raw-pcap sidecar: RedLog holds no packets, only the sha256 of each operator-
// side .pcap segment (which goes on the chain). pcapSegmentEvent is the tested
// core — hash a real file, produce the integrity record.

let dir: string
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

describe('pcapSegmentEvent', () => {
  it('records a segment as path + sha256 + bytes', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-pcap-'))
    const file = path.join(dir, 'redlog-20260907-120000.pcap')
    const bytes = Buffer.from('PCAP-RAW-BYTES-not-really-but-fine')
    fs.writeFileSync(file, bytes)
    const expected = crypto.createHash('sha256').update(bytes).digest('hex')

    const ev = pcapSegmentEvent(file)
    expect(ev).toMatchObject({
      subtype: 'pcap_segment',
      pcap_file: file,
      pcap_sha256: expected,
      bytes: bytes.length
    })
    // Honest note: the packets stay on disk, only the hash is on the chain.
    expect(ev.note).toMatch(/only its sha256 is on the chain/)
  })

  it('returns null for a missing or empty file (never a wrong hash)', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-pcap-'))
    expect(pcapSegmentEvent(path.join(dir, 'nope.pcap'))).toBeNull()
    const empty = path.join(dir, 'empty.pcap')
    fs.writeFileSync(empty, '')
    expect(pcapSegmentEvent(empty)).toBeNull()
  })
})
