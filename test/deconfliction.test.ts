import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'http'
import crypto from 'crypto'
import type { AddressInfo } from 'net'
import {
  configureDeconfliction, getDeconflictionConfig, notifyDeconfliction,
  flushDeconflictionOnShutdown, _flushDeconflictionForTest, testWebhook
} from '../src/core/deconfliction'
import type { RedLogEvent } from '../src/core/db/events'

// v0.9.10: deconfliction sends engagement data to an external SOC endpoint and
// had no tests. Everything here matters to someone outside the operator's
// machine: which events leave, how much of each, and whether the receiver can
// tell the payload came from this RedLog.

interface Received { body: string; sig: string | undefined; path: string }
let server: http.Server
let received: Received[] = []
let url = ''

const ev = (over: Partial<RedLogEvent> = {}): RedLogEvent => ({
  id: 'e1', timestamp: 1, engagementId: 'eng', sessionId: 's', operatorId: 'op',
  agentType: 'shell', hostname: 'h', data: { subtype: 'command_end', command: 'id', secret_field: 'TOPSECRET' },
  hash: 'abc', prevHash: null, createdAt: 1, ...over
} as RedLogEvent)

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 120))

describe('deconfliction webhook', () => {
  beforeEach(async () => {
    received = []
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        received.push({ body, sig: req.headers['x-redlog-signature'] as string | undefined, path: req.url ?? '' })
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/soc`
  })
  afterEach(async () => {
    configureDeconfliction({ enabled: false, url: '', secret: '', events: [], subtypes: [], includeData: false, authorityFloor: 'inferred' })
    await new Promise<void>((r) => server.close(() => r()))
  })

  const on = (over: Partial<Parameters<typeof configureDeconfliction>[0]> = {}): void =>
    configureDeconfliction({ enabled: true, url, secret: 'sekrit', events: ['marker'], subtypes: [], includeData: false, ...over })

  it('sends nothing while disabled', async () => {
    on({ enabled: false })
    notifyDeconfliction(ev({ agentType: 'marker' }))
    _flushDeconflictionForTest(); await settle()
    expect(received).toHaveLength(0)
  })

  it('sends nothing when no url is configured', async () => {
    on({ url: '' })
    notifyDeconfliction(ev({ agentType: 'marker' }))
    _flushDeconflictionForTest(); await settle()
    expect(received).toHaveLength(0)
  })

  it('forwards only the configured agent types', async () => {
    on({ events: ['marker'] })
    notifyDeconfliction(ev({ agentType: 'shell' }))    // not configured
    notifyDeconfliction(ev({ agentType: 'marker' }))
    _flushDeconflictionForTest(); await settle()
    expect(received).toHaveLength(1)
    expect(JSON.parse(received[0].body)).toHaveLength(1)
    expect(JSON.parse(received[0].body)[0].agent_type).toBe('marker')
  })

  it('forwards by subtype even when the agent type is not listed', async () => {
    on({ events: [], subtypes: ['scope_violation'] })
    notifyDeconfliction(ev({ agentType: 'system', data: { subtype: 'scope_violation' } }))
    _flushDeconflictionForTest(); await settle()
    expect(received).toHaveLength(1)
  })

  it('omits the event body unless includeData is set — this is the PII gate', async () => {
    on({ events: ['shell'], includeData: false })
    notifyDeconfliction(ev())
    _flushDeconflictionForTest(); await settle()
    const [row] = JSON.parse(received[0].body)
    expect(row.data).toBeUndefined()
    expect(received[0].body).not.toContain('TOPSECRET')
    // The summary fields the blue team actually needs still go.
    expect(row).toMatchObject({ id: 'e1', agent_type: 'shell', hash: 'abc', subtype: 'command_end' })
  })

  it('includes the body when includeData is set', async () => {
    on({ events: ['shell'], includeData: true })
    notifyDeconfliction(ev())
    _flushDeconflictionForTest(); await settle()
    expect(received[0].body).toContain('TOPSECRET')
  })

  it('signs the exact bytes sent, so the receiver can verify them', async () => {
    on({ events: ['marker'], secret: 'sekrit' })
    notifyDeconfliction(ev({ agentType: 'marker' }))
    _flushDeconflictionForTest(); await settle()
    const expected = crypto.createHmac('sha256', 'sekrit').update(received[0].body).digest('hex')
    // The header is `sha256=<hex>` — the algorithm prefix is part of the wire
    // contract (docs/deconfliction.md), so pin the whole value, not just the
    // digest. A receiver stripping the wrong number of characters silently
    // fails every verification.
    expect(received[0].sig).toBe(`sha256=${expected}`)
  })

  it('batches multiple events into a single POST', async () => {
    on({ events: ['marker'] })
    for (let i = 0; i < 5; i++) notifyDeconfliction(ev({ id: `e${i}`, agentType: 'marker' }))
    _flushDeconflictionForTest(); await settle()
    expect(received).toHaveLength(1)
    expect(JSON.parse(received[0].body)).toHaveLength(5)
  })

  it('flushes buffered events on shutdown rather than dropping them', async () => {
    on({ events: ['marker'] })
    notifyDeconfliction(ev({ agentType: 'marker' }))
    flushDeconflictionOnShutdown()
    await settle()
    expect(received, 'quitting mid-batch must not silently discard the buffer').toHaveLength(1)
  })

  it('testWebhook reports a reachable endpoint', async () => {
    const r = await testWebhook({ enabled: true, url, secret: 's', events: [], subtypes: [], includeData: false })
    expect(r.ok).toBe(true)
    expect(r.status).toBe(200)
  })

  it('testWebhook fails cleanly with no url', async () => {
    const r = await testWebhook({ enabled: true, url: '', secret: 's', events: [], subtypes: [], includeData: false })
    expect(r.ok).toBe(false)
  })

  // G-C2. A `scope_violation` for a neighbouring host is a proximity INFERENCE;
  // one for an explicitly excluded target is an observed rule match. Before
  // this the blue team received both in the same shape, with nothing on the
  // wire to tell them apart — an inference delivered as a fact.
  describe('authority tiering', () => {
    const violation = (authority: 'fact' | 'inferred', reason: string): RedLogEvent =>
      ev({ agentType: 'system', data: { subtype: 'scope_violation', reason, authority } })

    const bodyOf = (): Record<string, unknown> => JSON.parse(received[0].body)[0]

    it('labels every forwarded event with its authority and reason', async () => {
      on({ events: ['system'] })
      notifyDeconfliction(violation('inferred', 'adjacent_subnet'))
      _flushDeconflictionForTest()
      await settle()
      expect(bodyOf().authority).toBe('inferred')
      expect(bodyOf().reason).toBe('adjacent_subnet')
    })

    // Both are bounded enums, so they ride outside the PII gate — the receiver
    // must be able to triage without being handed the command text.
    it('carries the labels even with includeData off', async () => {
      on({ events: ['system'], includeData: false })
      notifyDeconfliction(violation('fact', 'excluded_target'))
      _flushDeconflictionForTest()
      await settle()
      expect(bodyOf().authority).toBe('fact')
      expect(bodyOf().data).toBeUndefined()
    })

    it('forwards both tiers by default — narrowing an outward feed is deliberate', async () => {
      on({ events: ['system'] })
      notifyDeconfliction(violation('inferred', 'adjacent_domain'))
      notifyDeconfliction(violation('fact', 'excluded_target'))
      _flushDeconflictionForTest()
      await settle()
      expect(JSON.parse(received[0].body)).toHaveLength(2)
    })

    it('a fact floor holds the inference back and lets the rule match through', async () => {
      on({ events: ['system'], authorityFloor: 'fact' })
      notifyDeconfliction(violation('inferred', 'adjacent_domain'))
      notifyDeconfliction(violation('fact', 'excluded_target'))
      _flushDeconflictionForTest()
      await settle()
      const batch = JSON.parse(received[0].body)
      expect(batch).toHaveLength(1)
      expect(batch[0].reason).toBe('excluded_target')
    })

    // Absence of `authority` is not an inferred claim. Silently cutting the
    // blue team off from every other event type is the wrong way to fail.
    it('an event with no authority field still forwards under a fact floor', async () => {
      on({ events: ['marker'], authorityFloor: 'fact' })
      notifyDeconfliction(ev({ agentType: 'marker' }))
      _flushDeconflictionForTest()
      await settle()
      expect(received).toHaveLength(1)
    })

    // The gate runs after the match, so it holds whichever branch matched.
    it('the floor applies to subtype-matched events too, not just agent-type ones', async () => {
      on({ events: [], subtypes: ['scope_violation'], authorityFloor: 'fact' })
      notifyDeconfliction(violation('inferred', 'adjacent_subnet'))
      _flushDeconflictionForTest()
      await settle()
      expect(received).toHaveLength(0)
    })
  })

  it('round-trips its config', () => {
    on({ events: ['marker', 'loot'], subtypes: ['scope_violation'] })
    expect(getDeconflictionConfig()).toMatchObject({ enabled: true, events: ['marker', 'loot'], subtypes: ['scope_violation'] })
  })
})
