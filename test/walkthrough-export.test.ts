import { describe, it, expect } from 'vitest'
import { targetWalkthroughMarkdown, type WalkthroughSection } from '../src/core/walkthrough-export'
import type { RedLogEvent } from '../src/core/db/events'

const ev = (agentType: string, data: Record<string, unknown>, ts = 1_700_000_000_000, targetId: string | null = null): RedLogEvent =>
  ({ agentType, data, timestamp: ts, targetId } as unknown as RedLogEvent)

describe('walkthrough-export — targetWalkthroughMarkdown', () => {
  const section: WalkthroughSection = {
    target: '10.10.11.24',
    eventCount: 42,
    operatorCount: 2,
    firstSeen: 1_700_000_000_000,
    lastSeen: 1_700_000_100_000,
    chain: [
      ev('dns', { subtype: 'dns_response', query_name: 'acme.example.com' }, 1_700_000_000_000, '10.10.11.24'),
      ev('shell', { subtype: 'command_end', command: 'nmap -sV 10.10.11.24', exit_code: 0 }, 1_700_000_010_000),
      ev('loot', { subtype: 'loot_found', loot_type: 'password_hash', preview: 'root:$6$...' }, 1_700_000_020_000),
      ev('marker', { subtype: 'created', title: 'admin panel', severity: 'important' }, 1_700_000_030_000),
      ev('system', { subtype: 'scope_violation', target: '10.10.11.24' }, 1_700_000_040_000, '10.10.11.24')
    ]
  }

  it('renders a ## section per target with a stats line', () => {
    const md = targetWalkthroughMarkdown([section])
    expect(md).toContain('## 10.10.11.24')
    expect(md).toContain('42 events · 2 operator(s)')
    expect(md).toContain('1 target(s).')
  })

  it('formats each turning-point type', () => {
    const md = targetWalkthroughMarkdown([section])
    expect(md).toContain('**DNS** acme.example.com → 10.10.11.24')
    expect(md).toContain('`$ nmap -sV 10.10.11.24` → exit 0')
    expect(md).toContain('**戰利品/loot** `password_hash`')
    expect(md).toContain('**標記/marker** admin panel (important)')
    expect(md).toContain('**⚠ 範圍違規/scope violation** 10.10.11.24')
  })

  it('neutralizes backticks in command text (no Markdown break-out)', () => {
    const md = targetWalkthroughMarkdown([{ ...section, chain: [
      ev('shell', { subtype: 'command_start', command: 'echo `id`' })
    ] }])
    expect(md).not.toContain('echo `id`')
    expect(md).toContain('echo ´id´')
  })

  it('an empty chain gets the placeholder note, not a bare heading', () => {
    const md = targetWalkthroughMarkdown([{ ...section, chain: [] }])
    expect(md).toContain('_(no commands, loot, markers, or resolutions recorded for this target)_')
  })

  it('empty input still renders a valid header', () => {
    const md = targetWalkthroughMarkdown([])
    expect(md).toContain('# RedLog target walkthrough')
    expect(md).toContain('0 target(s).')
  })
})
