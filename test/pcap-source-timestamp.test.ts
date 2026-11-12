import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// pcap-agent sent no source_timestamp, so a payload that reached RedLog through
// the spool was placed at its replay time and could not be judged against a
// recorded pause (Spec 071 FR-082): it was written whenever it had been seen.

const homes: string[] = []
afterEach(() => { for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true }) })

describe('pcap-agent source time', () => {
  it('stamps each payload with when the packet was seen: `at`, a scan\'s first SYN, else now', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-pcap-time-'))
    homes.push(home)
    const result = spawnSync('python3', ['test/fixtures/pcap-source-time-check.py', home], { encoding: 'utf8', timeout: 60000 })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([
      { subtype: 'connection_attempt', source_timestamp: 1_780_000_000_001 },
      { subtype: 'port_scan', source_timestamp: 1_780_000_000_100 },
      { subtype: 'udp_flow', source_timestamp: 1_790_000_000_000 }
    ])
  }, 60000)
})
