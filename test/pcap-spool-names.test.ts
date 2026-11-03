import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// pcap-agent named a spooled payload by a millisecond clock and id(payload) and
// opened it with O_TRUNC, so two payloads in one tick shared a file and the
// first was lost. The clock is frozen here, as a coarse tick makes it.

const homes: string[] = []
afterEach(() => { for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true }) })

describe('pcap-agent spool names', () => {
  it('keeps every payload written inside one tick, in the order written, and leaves no temporary file', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-pcap-spool-'))
    homes.push(home)
    const result = spawnSync('python3', ['test/fixtures/pcap-spool-names-check.py', home], { encoding: 'utf8', timeout: 60000 })
    expect(result.status, result.stderr).toBe(0)
    const r = JSON.parse(result.stdout) as { written: number; ordered: number[]; concurrent_kept: number[]; leftovers: string[] }
    const all = Array.from({ length: r.written }, (_, i) => i)
    expect(r.ordered).toEqual(all)
    expect(r.concurrent_kept).toEqual(all)
    expect(r.leftovers).toEqual([])
  }, 60000)
})
