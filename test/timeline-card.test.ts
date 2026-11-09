// Stitch 05 card rail: a card is built from fields the event carries and
// nothing else. The claims the prototype made that no recorded field supports
// ("scan", "port open", "flag captured") must not be producible.

import { describe, expect, it } from 'vitest'
import { buildCard, stdoutStart } from '../src/renderer/src/lib/timelineCard'
import { eventTitle } from '../src/renderer/src/lib/eventTitle'
import type { RedLogEvent } from '../src/core/db/event-types'

const ev = (agentType: string, data: Record<string, unknown>, timestamp = 1_700_000_000_000): RedLogEvent => ({
  id: `${agentType}-${String(data.subtype ?? '')}`, timestamp, engagementId: 'e', sessionId: 's', operatorId: 'op',
  agentType, hostname: 'h', sourceIP: null, targetId: null, data, createdAt: timestamp
} as RedLogEvent)

const t = (k: string, v?: Record<string, string | number>): string => (v ? `${k}${JSON.stringify(v)}` : k)
const ctx = { t, titleOf: (e: RedLogEvent) => eventTitle(e), pluginTypes: [] }

describe('buildCard', () => {
  it('shell command_end: exit code and duration, cwd as the detail, title from titleOf', () => {
    const c = buildCard(ev('shell', { subtype: 'command_end', command: 'ls', exit_code: 2, duration_sec: 1.5, cwd: '/tmp' }), ctx)
    expect(c.title).toBe('$ ls → exit 2')
    expect(c.typeTag).toBe('timeline.shell')
    expect(c.meta).toEqual(['transcript.metaExit{"code":2}', '1.5s'])
    expect(c.detail).toBe('/tmp')
    expect(c.lane).toBe('shell')
  })

  it('shell command_start has no result and no detail without a cwd', () => {
    const c = buildCard(ev('shell', { subtype: 'command_start', command: 'id' }), ctx)
    expect(c.meta).toEqual([])
    expect(c.detail).toBeUndefined()
  })

  it('HTTP response: status, size and duration from the event; content type as detail', () => {
    const c = buildCard(ev('scanner', {
      subtype: 'http_response', method: 'GET', url: 'http://x/a', status: 200, content_length: 2048, duration_ms: 31, content_type: 'text/html'
    }), ctx)
    expect(c.meta).toEqual(['200', '2 KB', '31 ms'])
    expect(c.detail).toBe('text/html')
  })

  it('HTTP request start has no status, size or duration to show', () => {
    expect(buildCard(ev('scanner', { subtype: 'http_request_start', method: 'GET', url: 'http://x/' }), ctx).meta).toEqual([])
  })

  it('an agent tool call shows a duration only when it recorded one', () => {
    expect(buildCard(ev('agent', { subtype: 'tool_call', tool_name: 'Bash', duration_ms: 12 }), ctx).meta).toEqual(['12 ms'])
    expect(buildCard(ev('agent', { subtype: 'tool_call', tool_name: 'Bash' }), ctx).meta).toEqual([])
  })

  it('loot: "signature match" and the matched types, never a flag claim', () => {
    const c = buildCard(ev('loot', { matches: [{ type: 'aws_key', confidence: 'high' }, { type: 'jwt', confidence: 'low' }, { type: 'aws_key', confidence: 'low' }] }), ctx)
    expect(c.typeTag).toBe('timeline.card.lootHit')
    expect(c.detail).toBe('aws key · jwt')
  })

  it('an out-of-scope observation is tagged as one; an in-scope tally is not', () => {
    const out = buildCard(ev('system', { subtype: 'scope_violation', target: '10.0.0.9', distance: 'outside' }), ctx)
    expect(out.typeTag).toBe('timeline.card.scopeObservation')
    expect(out.lane).toBe('scope')
    const inside = buildCard(ev('system', { subtype: 'scope_violation', target: '10.0.0.1', distance: 'in_scope' }), ctx)
    expect(inside.typeTag).toBe('timeline.scope')
  })

  it('invents nothing: an event with no fields has no meta, detail or stdout', () => {
    const c = buildCard(ev('marker', { title: 'x', severity: 'info' }), { ...ctx, withStdout: true })
    expect(c.meta).toEqual([])
    expect(c.detail).toBeUndefined()
    expect(c.stdout).toBeUndefined()
  })

  it('never emits the prototype\'s unsupported claims, whatever the output says', () => {
    const cards = [
      buildCard(ev('shell', { subtype: 'command_end', command: 'nmap -sV x', exit_code: 0, stdout: '5432/tcp open postgresql' }), { ...ctx, withStdout: true }),
      buildCard(ev('loot', { matches: [{ type: 'flag', confidence: 'high' }] }), ctx),
      buildCard(ev('system', { subtype: 'scope_violation', target: 't' }), ctx)
    ]
    for (const c of cards) {
      for (const part of [c.typeTag, c.detail ?? '', ...c.meta]) {
        expect(part).not.toMatch(/掃描|FLAG|登錄完畢|PORT|邊界探測警戒/)
      }
    }
  })
})

describe('stdout', () => {
  it('is the start of inline data.stdout, only for the focused card', () => {
    const e = ev('shell', { subtype: 'command_end', command: 'ls', stdout: 'a\nb\nc\nd\ne\nf\ng\nh' })
    expect(buildCard(e, ctx).stdout).toBeUndefined()
    expect(buildCard(e, { ...ctx, withStdout: true }).stdout).toBe('a\nb\nc\nd\ne\nf')
  })

  it('is capped in length and absent for empty or non-string output', () => {
    expect(stdoutStart(ev('shell', { stdout: 'x'.repeat(1000) }))!.length).toBe(401)
    expect(stdoutStart(ev('shell', { stdout: '  ' }))).toBeUndefined()
    expect(stdoutStart(ev('shell', { stdout_ref: { sha256: 'a' } }))).toBeUndefined()
  })
})
