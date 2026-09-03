import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { isHousekeeping, isHookSource } from '../src/renderer/src/lib/housekeeping'
import type { RedLogEvent } from '../src/core/db/events'

// The same question is asked twice — once in JS for what is rendered, once in
// SQL so the pager does not fetch 200 rows and show 30. Two copies of a rule
// drift; this is what notices.

let seq = 0
const ev = (agentType: string, data: Record<string, unknown>): RedLogEvent => {
  seq += 1
  return {
    id: `e${seq}`, timestamp: seq, engagementId: 'e', sessionId: 's', operatorId: 'o',
    agentType, hostname: 'h', sourceIP: null, targetId: null, data, createdAt: seq
  }
}

const HOUSEKEEPING: RedLogEvent[] = [
  ev('system', { subtype: 'api_started' }),
  ev('system', { subtype: 'session_start' }),
  ev('shell', { subtype: 'session_start' }),
  ev('terminal', { subtype: 'session_start' }),
  ev('shell', { subtype: 'command_start', command: '/opt/redlog/shell-preexec-hook.sh install' }),
  ev('shell', { subtype: 'command', command: 'bash /x/shell-preexec-hook.sh' })
]

const EVIDENCE: RedLogEvent[] = [
  ev('shell', { subtype: 'command_start', command: 'nmap -sV 10.0.0.5' }),
  ev('shell', { subtype: 'command_end', command: 'nmap', exitCode: 0 }),
  ev('shell', { subtype: 'session_end', castPath: '/x.cast' }),
  ev('system', { subtype: 'ip_verdict', kind: 'unknown' }),
  ev('marker', { title: 'a finding' }),
  ev('dns', { subtype: 'dns_query', query_name: 'a.example' })
]

describe('housekeeping', () => {
  it('hides RedLog talking to itself', () => {
    for (const e of HOUSEKEEPING) expect(isHousekeeping(e), JSON.stringify(e.data)).toBe(true)
  })

  it('shows everything else, including the app-generated rows that ARE evidence', () => {
    // `system.ip_verdict` is a conclusion about the engagement, not plumbing —
    // which is why the visibility model needed a separate, positive predicate
    // rather than reusing this one.
    for (const e of EVIDENCE) expect(isHousekeeping(e), JSON.stringify(e.data)).toBe(false)
  })

  it('recognises the hook by its script name only', () => {
    expect(isHookSource('/x/shell-preexec-hook.sh')).toBe(true)
    expect(isHookSource('curl https://example/shell-preexec-hookXsh')).toBe(false)
    expect(isHookSource(undefined)).toBe(false)
  })

  it('agrees with the SQL twin on every fixture', () => {
    const sql = fs.readFileSync(path.join(__dirname, '../src/core/db/events.ts'), 'utf-8')
    const block = sql.slice(sql.indexOf('const HOUSEKEEPING_SQL'), sql.indexOf('const HOUSEKEEPING_SQL') + 900)
    // Structural rather than a re-implementation: every rule the JS applies has
    // to be named in the SQL, or the pager and the view disagree about which
    // rows exist.
    for (const rule of ['api_started', 'session_start', 'shell-preexec-hook.sh', 'command_start']) {
      expect(block, `SQL is missing the ${rule} rule`).toContain(rule)
    }
    expect(block).toContain("agent_type = 'terminal'")
  })
})
