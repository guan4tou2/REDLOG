// The port half of the command→traffic join, parsed from each platform's
// socket listing.
//
// It used to be the connection monitor's job and it could not do it: that
// ships off by default, inside an opt-in pack, and polls every two seconds,
// while a dirb connection lives fifty milliseconds. The addon asks instead,
// because it is the process holding the socket.
//
// The parsing is what can be wrong, so it is tested against real output
// shapes. A wrong pid becomes a wrong claim about which command produced a
// request, in a record handed to a client — so every parser here must skip
// what it does not fully understand rather than guess at it.

import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const ADDON = readFileSync(join(__dirname, '..', 'hooks', 'mitmproxy-addon.py'), 'utf-8')

/** The parser, lifted out of the addon and run on its own — the addon itself
 *  imports mitmproxy, which is not installed here. */
function parse(platform: string, out: string): Record<string, number> | null {
  const fn = /^def _parse_owner_output[\s\S]*?\n    return table\n/m.exec(ADDON)
  if (!fn) throw new Error('_parse_owner_output not found — did it move?')
  const dir = mkdtempSync(join(tmpdir(), 'redlog-owner-'))
  try {
    const script = join(dir, 's.py')
    writeFileSync(script, `${fn[0]}
import json, sys
print(json.dumps(_parse_owner_output(sys.argv[1], sys.stdin.read())))
`)
    for (const exe of ['python3', 'python']) {
      try {
        return JSON.parse(execFileSync(exe, [script, platform], { input: out, encoding: 'utf-8' }))
      } catch (e) {
        if ((e as { code?: string }).code === 'ENOENT') continue
        throw e
      }
    }
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const available = parse('linux', '') !== null

describe.skipIf(!available)('reading which process owns a socket', () => {
  it('parses ss on Linux, where the pid is on the line', () => {
    const out = [
      'ESTAB 0 0  127.0.0.1:54321  127.0.0.1:8080  users:(("dirb",pid=123,fd=3))',
      'ESTAB 0 0  127.0.0.1:54322  127.0.0.1:8080  users:(("curl",pid=456,fd=5))'
    ].join('\n')
    expect(parse('linux', out)).toEqual({ 54321: 123, 54322: 456 })
  })

  it('skips an ss line with no owner rather than attributing it to the last one', () => {
    // A socket whose owner `ss` could not read is not the previous socket's
    // process, and the record must not say it was.
    const out = [
      'ESTAB 0 0  127.0.0.1:54321  127.0.0.1:8080  users:(("dirb",pid=123,fd=3))',
      'ESTAB 0 0  127.0.0.1:54399  127.0.0.1:8080'
    ].join('\n')
    expect(parse('linux', out)).toEqual({ 54321: 123 })
  })

  it('parses lsof field output on macOS, where the pid is on its own line', () => {
    const out = ['p123', 'cdirb', 'n127.0.0.1:54321->127.0.0.1:8080', 'p456', 'n127.0.0.1:54322->127.0.0.1:8080'].join('\n')
    expect(parse('darwin', out)).toEqual({ 54321: 123, 54322: 456 })
  })

  it('does not carry a bad lsof pid onto the addresses that follow it', () => {
    const out = ['p-', 'n127.0.0.1:54321->127.0.0.1:8080', 'p456', 'n127.0.0.1:54322->127.0.0.1:8080'].join('\n')
    expect(parse('darwin', out)).toEqual({ 54322: 456 })
  })

  it('parses netstat on Windows and takes only established connections', () => {
    // A LISTENING row's "local port" is the proxy's own, and attributing a
    // client flow to whatever is listening would cite the wrong process every
    // single time.
    const out = [
      '  Proto  Local Address      Foreign Address    State           PID',
      '  TCP    127.0.0.1:54321    127.0.0.1:8080     ESTABLISHED     1234',
      '  TCP    0.0.0.0:8080       0.0.0.0:0          LISTENING       999'
    ].join('\r\n')
    expect(parse('win32', out)).toEqual({ 54321: 1234 })
  })

  it('handles IPv6, where the address has colons of its own', () => {
    const out = 'ESTAB 0 0  [::1]:54321  [::1]:8080  users:(("dirb",pid=123,fd=3))'
    expect(parse('linux', out)).toEqual({ 54321: 123 })
  })

  it('returns nothing for empty output, a tool that is not installed, or an unknown platform', () => {
    expect(parse('linux', '')).toEqual({})
    expect(parse('darwin', '')).toEqual({})
    expect(parse('freebsd', 'anything at all')).toEqual({})
  })
})

describe('the addon sends the owner wherever it sends the address', () => {
  it('attaches a pid at every source_addr site', () => {
    // The join needs both halves. A site added later that sends only the
    // address goes back to being unattributable, silently.
    const addrSites = ADDON.match(/source_addr['"]?\]?\s*[:=]\s*(client_addr|source_addr)/g) ?? []
    const pidSites = ADDON.match(/_socket_owner_pid\(/g) ?? []
    expect(addrSites.length).toBeGreaterThan(0)
    // One definition, one call per emitting site.
    expect(pidSites.length).toBeGreaterThanOrEqual(addrSites.length)
  })

  it('never resolves the owner on the hot path', () => {
    // mitmproxy runs addon hooks on its event loop, and a scan opens hundreds
    // of connections a second. A subprocess inline would stall the proxy —
    // dropping traffic in order to find out who sent it.
    expect(ADDON).toMatch(/_owner_loop/)
    expect(ADDON).toMatch(/threading\.Thread\(target=_owner_loop, daemon=True\)/)
    const lookup = /def _socket_owner_pid[\s\S]*?\n\n/.exec(ADDON)?.[0] ?? ''
    expect(lookup).not.toMatch(/subprocess/)
  })
})
